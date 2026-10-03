process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { after, before, beforeEach, afterEach, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const stages = [256, 258, 262, 263].map(n => require(`../src/utils/db-init-stage${n}`));
const { encodeScopeBitmap, SCOPE_TOKENS_SQL } = require('../src/models/robinhood-wallet-transfer-scope-bitmap');
const { auditMaps, publishScopeMaps } = require('../src/models/robinhood-wallet-transfer-scope-publisher');
const { parseArgs } = require('../src/utils/publish-robinhood-wallet-transfer-scope-maps');
const { createRobinhoodWalletRankingTransferScanCoverageRepository } = require('../src/models/robinhood-wallet-ranking-transfer-scan-coverage');
const digest = v => createHash('sha256').update(v).digest('hex');
const hash = v => digest(JSON.stringify(v));
const tokens = [1, 2, 3].map(n => `0x${n.toString(16).padStart(40, '0')}`);
let client, schema, audit;
const database = { getClient: async () => ({ query: (...args) => client.query(...args), release() {} }) };
function sign(state) { return { ...state, checksum: hash(state) }; }
async function snapshot() {
  return {
    ranges: (await client.query('SELECT * FROM robinhood_wallet_transfer_scan_scopes ORDER BY scan_scope_id')).rows,
    arrays: (await client.query('SELECT scope_hash,token_addresses FROM robinhood_wallet_transfer_token_scopes ORDER BY scope_hash')).rows,
    dictionary: (await client.query('SELECT * FROM robinhood_wallet_transfer_scope_dictionary ORDER BY ordinal')).rows,
  };
}
describe('Audited scope map publication', () => {
  before(async () => { await assertUsingTestDatabase(db); client = await db.getClient(); });
  beforeEach(async () => {
    schema = `test_publisher_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
    for (const stage of stages) for (const sql of stage.STATEMENTS) await client.query(sql);
    await client.query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address)
      SELECT 'robinhood',unnest($1::text[])`, [tokens]);
    const dictionary = (await client.query('SELECT token_address,ordinal FROM robinhood_wallet_transfer_scope_dictionary ORDER BY ordinal')).rows;
    const completed = [];
    for (const members of [tokens, tokens.slice(1)]) {
      const p = encodeScopeBitmap(members, dictionary);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_bitmap_staging
        (chain,scope_hash,scope_bitmap,dictionary_size,bitmap_token_count) VALUES ('robinhood',$1,$2,$3,$4)`,
      [p.scopeHash, p.bitmap, p.dictionarySize, p.tokenCount]);
      completed.push({ hash: p.scopeHash, source: p.scopeHash, count: p.tokenCount, storage: 'staging',
        bitmap: hash({ hash: p.scopeHash, size: p.dictionarySize, count: p.tokenCount, bytes: digest(p.bitmap) }) });
    }
    await client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes(chain,scope_hash,token_addresses)
      VALUES ('robinhood',$1,$2)`, [completed[0].hash, tokens]);
    await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
      (chain,projection_version,stream,from_block,through_block,checkpoint_hash,filter_mode,token_addresses,token_scope_hash)
      VALUES ('robinhood','test','live',1,2,$1,'topics-only',NULL,$2),
      ('robinhood','test','live',3,4,$1,'topics-only',$3,NULL)`,
    [`0x${'f'.repeat(64)}`, completed[0].hash, tokens.slice(1)]);
    audit = sign({ version: 1, finalPassedAt: new Date().toISOString(),
      context: { validator: 'stage263-membership-v1', dictionary: hash(dictionary),
        codec: digest(fs.readFileSync(require.resolve('../src/models/robinhood-wallet-transfer-scope-bitmap'))) }, completed });
  });
  afterEach(async () => { if (schema) await client.query(`DROP SCHEMA ${schema} CASCADE`); });
  after(async () => { client?.release(); await db.pool.end(); });
  it('simulates in read-only transactions and preserves arrays, ranges and dictionary', async () => {
    const original = await snapshot();
    const readonly = { getClient: async () => ({ release() {}, async query(sql, params) {
      const result = await client.query(sql, params);
      if (sql.startsWith('BEGIN')) assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      return result;
    } }) };
    const report = await publishScopeMaps(readonly, { audit, maxMaps: 50 });
    assert.equal(report.stopReason, 'cohort-end'); assert.equal(report.measured.length, 2);
    assert.deepEqual(report.measured.map(m => m.status).sort(), ['deferred-array-cutover', 'would-publish']);
    assert.deepEqual(await snapshot(), original);
  });
  it('publishes missing maps idempotently and defers legacy arrays without updating them', async () => {
    const original = await snapshot();
    await client.query(`CREATE FUNCTION forbid_legacy_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'legacy update forbidden'; END $$`);
    await client.query(`CREATE TRIGGER forbid_legacy_update BEFORE UPDATE OR DELETE ON robinhood_wallet_transfer_token_scopes
      FOR EACH STATEMENT EXECUTE FUNCTION forbid_legacy_update()`);
    const report = await publishScopeMaps(database, { audit, maxMaps: 50, commit: true });
    assert.deepEqual(report.measured.map(m => m.status).sort(), ['deferred-array-cutover', 'published']);
    const now = await snapshot();
    assert.deepEqual(now.ranges, original.ranges); assert.deepEqual(now.dictionary, original.dictionary);
    assert.deepEqual(now.arrays.filter(r => r.token_addresses !== null), original.arrays);
    const memberships = (await client.query(`SELECT ${SCOPE_TOKENS_SQL} AS tokens
      FROM robinhood_wallet_transfer_scan_scopes s LEFT JOIN robinhood_wallet_transfer_token_scopes t
      ON t.chain=s.chain AND t.scope_hash=s.token_scope_hash ORDER BY s.scan_scope_id`)).rows;
    assert.deepEqual(memberships.map(r => r.tokens), [tokens, tokens.slice(1)]);
    const retry = await publishScopeMaps(database, { audit, maxMaps: 50, commit: true });
    assert.deepEqual(retry.measured.map(m => m.status).sort(), ['deferred-array-cutover', 'verified-existing']);
    assert.deepEqual(await snapshot(), now);
  });
  it('rolls back an interrupted map, reports committed progress and resumes precisely', async () => {
    // Both maps are absent from the publication table in this isolated fixture.
    await client.query('UPDATE robinhood_wallet_transfer_scan_scopes SET token_addresses=$1,token_scope_hash=NULL WHERE token_scope_hash IS NOT NULL', [tokens]);
    await client.query('DELETE FROM robinhood_wallet_transfer_token_scopes');
    let writes = 0;
    const failing = { getClient: async () => ({ release() {}, query(sql, params) {
      if (/^(INSERT INTO|UPDATE) robinhood_wallet_transfer_token_scopes/.test(sql) && ++writes === 2) throw new Error('injected failure');
      return client.query(sql, params);
    } }) };
    let resume;
    await assert.rejects(publishScopeMaps(failing, { audit, maxMaps: 50, commit: true }), error => {
      assert.equal(error.publicationReport.measured.length, 1); resume = error.publicationReport.resume;
      return /injected/.test(error.message);
    });
    assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_wallet_transfer_token_scopes WHERE scope_bitmap IS NOT NULL')).rows[0].n, 1);
    const result = await publishScopeMaps(database, { audit, maxMaps: 50, commit: true, ...resume });
    assert.equal(result.measured.length, 1); assert.equal(result.stopReason, 'cohort-end');
  });
  it('defers a GIN/TOAST-backed 414065-token array until explicit atomic cutover', async (t) => {
    const members = Array.from({ length: 414065 }, (_, n) => `0x${n.toString(16).padStart(40, '0')}`);
    for (let offset = 0; offset < members.length; offset += 5000) {
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address)
        SELECT 'robinhood',unnest($1::text[]) ON CONFLICT(chain,token_address) DO NOTHING`, [members.slice(offset, offset + 5000)]);
    }
    const dictionary = (await client.query('SELECT token_address,ordinal FROM robinhood_wallet_transfer_scope_dictionary ORDER BY ordinal')).rows;
    const p = encodeScopeBitmap(members, dictionary);
    await client.query(`INSERT INTO robinhood_wallet_transfer_scope_bitmap_staging
      (chain,scope_hash,scope_bitmap,dictionary_size,bitmap_token_count) VALUES ('robinhood',$1,$2,$3,$4)`,
    [p.scopeHash, p.bitmap, p.dictionarySize, p.tokenCount]);
    await client.query('ALTER TABLE robinhood_wallet_transfer_token_scopes ALTER COLUMN token_addresses SET STORAGE EXTERNAL');
    await client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes(chain,scope_hash,token_addresses)
      VALUES ('robinhood',$1,$2)`, [p.scopeHash, members]);
    assert.ok((await client.query('SELECT pg_column_size(token_addresses) AS bytes FROM robinhood_wallet_transfer_token_scopes WHERE scope_hash=$1',
      [p.scopeHash])).rows[0].bytes > 16 * 1024 * 1024);
    const { checksum: unused, ...state } = audit; void unused;
    const largeAudit = sign({ ...state, context: { ...state.context, dictionary: hash(dictionary) },
      completed: [{ hash: p.scopeHash, source: p.scopeHash, count: p.tokenCount, storage: 'staging',
        bitmap: hash({ hash: p.scopeHash, size: p.dictionarySize, count: p.tokenCount, bytes: digest(p.bitmap) }) }] });
    const result = await publishScopeMaps(database, { audit: largeAudit, commit: true, budgetMs: 30000 });
    assert.equal(result.measured[0].status, 'deferred-array-cutover');
    const row = (await client.query(`SELECT token_addresses,scope_bitmap FROM robinhood_wallet_transfer_token_scopes
      WHERE scope_hash=$1`, [p.scopeHash])).rows[0];
    assert.deepEqual(row.token_addresses, members); assert.equal(row.scope_bitmap, null);
    const started = Date.now();
    const cutover = await publishScopeMaps(database, { audit: largeAudit, cutoverArrays: true, commit: true, budgetMs: 30000 });
    t.diagnostic(`414065-token cutover including validation: ${Date.now() - started}ms`);
    assert.equal(cutover.measured[0].status, 'array-cutover');
    const compact = (await client.query('SELECT token_addresses,scope_bitmap,bitmap_token_count FROM robinhood_wallet_transfer_token_scopes WHERE scope_hash=$1',
      [p.scopeHash])).rows[0];
    assert.equal(compact.token_addresses, null); assert.equal(compact.bitmap_token_count, members.length);
    assert.deepEqual(compact.scope_bitmap, p.bitmap);
  });
  it('simulates cutover in read-only transactions without retiring any arrays', async () => {
    await publishScopeMaps(database, { audit, maxMaps: 50, commit: true });
    const original = await snapshot();
    const readonly = { getClient: async () => ({ release() {}, async query(sql, params) {
      const result = await client.query(sql, params);
      if (sql.startsWith('BEGIN')) assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      return result;
    } }) };
    const result = await publishScopeMaps(readonly, { audit, maxMaps: 50, cutoverArrays: true });
    assert.equal(result.operation, 'hashed-array-cutover');
    assert.deepEqual(result.measured.map(m => m.status).sort(), ['verified-existing', 'would-cutover-array']);
    assert.deepEqual(await snapshot(), original);
  });
  it('keeps the committed array visible until its equivalent bitmap commits and makes replay read-only', async () => {
    await publishScopeMaps(database, { audit, maxMaps: 50, commit: true });
    const original = await snapshot(), observer = await db.getClient();
    let writes = 0;
    try {
      await observer.query(`SET search_path TO ${schema}`);
      const atomic = { getClient: async () => ({ release() {}, async query(sql, params) {
        const result = await client.query(sql, params);
        if (sql.startsWith('UPDATE robinhood_wallet_transfer_token_scopes')) {
          writes++;
          const visible = (await observer.query('SELECT token_addresses,scope_bitmap FROM robinhood_wallet_transfer_token_scopes WHERE scope_hash=$1', [params[0]])).rows[0];
          assert.deepEqual(visible.token_addresses, tokens); assert.equal(visible.scope_bitmap, null);
          assert.equal(result.rows[0].token_addresses, null);
        }
        return result;
      } }) };
      const result = await publishScopeMaps(atomic, { audit, maxMaps: 50, commit: true, cutoverArrays: true });
      assert.equal(result.mode, 'cutover-hashed-arrays'); assert.equal(writes, 1);
      const now = await snapshot(); assert.deepEqual(now.ranges, original.ranges); assert.deepEqual(now.dictionary, original.dictionary);
      const memberships = (await observer.query(`SELECT ${SCOPE_TOKENS_SQL} AS tokens
        FROM robinhood_wallet_transfer_scan_scopes s LEFT JOIN robinhood_wallet_transfer_token_scopes t
        ON t.chain=s.chain AND t.scope_hash=s.token_scope_hash ORDER BY s.scan_scope_id`)).rows;
      assert.deepEqual(memberships.map(r => r.tokens), [tokens, tokens.slice(1)]);
      const retry = await publishScopeMaps(atomic, { audit, maxMaps: 50, commit: true, cutoverArrays: true });
      assert.ok(retry.measured.every(m => m.status === 'verified-existing')); assert.equal(writes, 1);
      await assert.rejects(client.query('UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=$1 WHERE scope_hash=$2',
        [tokens, audit.completed[0].hash]), /immutable/);
    } finally { observer.release(); }
  });
  it('rolls back a failed cutover and resumes after only the committed hash', async () => {
    await client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes(chain,scope_hash,token_addresses)
      VALUES ('robinhood',$1,$2)`, [audit.completed[1].hash, tokens.slice(1)]);
    let writes = 0, resume;
    const failing = { getClient: async () => ({ release() {}, async query(sql, params) {
      const result = await client.query(sql, params);
      if (sql.startsWith('UPDATE robinhood_wallet_transfer_token_scopes') && ++writes === 2) throw new Error('injected cutover failure');
      return result;
    } }) };
    await assert.rejects(publishScopeMaps(failing, { audit, maxMaps: 50, commit: true, cutoverArrays: true }), error => {
      assert.equal(error.publicationReport.measured.length, 1); resume = error.publicationReport.resume;
      assert.equal(error.publicationReport.operation, 'hashed-array-cutover'); return /injected/.test(error.message);
    });
    assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_wallet_transfer_token_scopes WHERE token_addresses IS NULL')).rows[0].n, 1);
    const rest = await publishScopeMaps(database, { audit, maxMaps: 50, commit: true, cutoverArrays: true, ...resume });
    assert.equal(rest.measured.length, 1); assert.equal(rest.measured[0].status, 'array-cutover');
    assert.equal(rest.stopReason, 'cohort-end');
  });
  it('refuses changed source arrays, absent published sets and lock contention before retiring sources', async () => {
    const original = await snapshot();
    await client.query('UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=$1', [tokens.slice(1)]);
    await assert.rejects(publishScopeMaps(database, { audit, maxMaps: 50, commit: true, cutoverArrays: true }), /differs from audited/);
    assert.equal((await client.query('SELECT scope_bitmap FROM robinhood_wallet_transfer_token_scopes')).rows[0].scope_bitmap, null);
    await client.query('UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=$1', [tokens]);
    const { checksum: unused, ...state } = audit; void unused;
    const other = sign({ ...state, completed: [audit.completed[1]] });
    await assert.rejects(publishScopeMaps(database, { audit: other, commit: true, cutoverArrays: true }), /publish maps before cutover/);
    const locker = await db.getClient();
    try {
      await locker.query(`SET search_path TO ${schema}`); await locker.query('BEGIN');
      await locker.query('SELECT scope_hash FROM robinhood_wallet_transfer_token_scopes FOR UPDATE');
      await assert.rejects(publishScopeMaps(database, { audit, maxMaps: 50, commit: true, cutoverArrays: true }), /lock timeout/);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
    assert.deepEqual(await snapshot(), original);
  });
  it('preserves the actual ranking coverage reader, including absent tokens, canonical and raw gates', async () => {
    for (const sql of require('../src/utils/db-init-stage259').STATEMENTS) await client.query(sql);
    await client.query(`CREATE TABLE robinhood_wallet_transfer_cursors (
      chain text,projection_version text,stream text,next_block bigint,version bigint,PRIMARY KEY(chain,projection_version,stream))`);
    for (const sql of require('../src/utils/db-init-stage261').STATEMENTS) await client.query(sql);
    await client.query('CREATE TABLE robinhood_chain_blocks (chain text,block_number bigint,block_hash text,canonical boolean)');
    await client.query("INSERT INTO robinhood_chain_blocks VALUES ('robinhood',2,$1,true)", [`0x${'f'.repeat(64)}`]);
    const input = { tokenAddresses: [...tokens, `0x${'4'.repeat(40)}`], classificationVersion: 'test',
      fromBlock: '1', throughBlock: '2', windowStart: '2026-10-01T00:00:00Z', asOf: '2026-10-02T00:00:00Z' };
    const read = (rawTransferAvailable = true) => createRobinhoodWalletRankingTransferScanCoverageRepository({
      database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      availabilityRepository: { inspectWindow: async () => ({ rawTransferAvailable, partitions: [] }) },
    }).inspectBlockRange(input);
    await publishScopeMaps(database, { audit, maxMaps: 50, commit: true });
    const before = await read(), beforeWithoutRaw = await read(false);
    assert.deepEqual(before.map(r => r.scanProofReady), [true, true, true, false]);
    await publishScopeMaps(database, { audit, maxMaps: 50, commit: true, cutoverArrays: true });
    assert.deepEqual(await read(), before); assert.deepEqual(await read(false), beforeWithoutRaw);
    await client.query('UPDATE robinhood_chain_blocks SET canonical=false');
    assert.ok((await read()).every(r => !r.scanProofReady));
  });
  it('rejects changed bitmap proofs or dictionary identity instead of publishing', async () => {
    const { checksum: unused, ...state } = audit; void unused;
    const bad = sign({ ...state, completed: state.completed.map(m => ({ ...m, bitmap: '0'.repeat(64) })) });
    await assert.rejects(publishScopeMaps(database, { audit: bad, commit: true }), /audited bitmap changed/);
    await client.query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address) VALUES ('robinhood',$1)`, [`0x${'4'.repeat(40)}`]);
    await assert.rejects(publishScopeMaps(database, { audit, commit: true }), /audited dictionary changed/);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_wallet_transfer_token_scopes WHERE scope_bitmap IS NOT NULL')).rows[0].n, 0);
  });
  it('requires complete checksummed evidence, bounded flags and a cohort resume cursor', async () => {
    assert.throws(() => auditMaps({ ...audit, checksum: '0'.repeat(64) }), /checkpoint/);
    const { checksum: unused, ...state } = audit; void unused;
    assert.throws(() => auditMaps(sign({ ...state, finalPassedAt: null })), /checkpoint/);
    assert.throws(() => auditMaps(sign({ ...state, completed: [...state.completed, state.completed[0]] })), /audited map/);
    await assert.rejects(publishScopeMaps(database, { audit, maxMaps: 51 }), /limits/);
    await assert.rejects(publishScopeMaps(database, { audit, cutoverArrays: 'true' }), /limits/);
    await assert.rejects(publishScopeMaps(database, { audit, afterHash: '0'.repeat(64) }), /resume/);
    assert.throws(() => parseArgs(['--commit']), /checkpoint/);
    assert.throws(() => parseArgs(['--checkpoint=a', '--commit', '--commit']), /argument/);
    assert.deepEqual(parseArgs(['--checkpoint=a', '--cutover-hashed-arrays']), { checkpoint: 'a', cutoverArrays: true });
    assert.throws(() => parseArgs(['--checkpoint=a', '--cutover-hashed-arrays', '--cutover-hashed-arrays']), /argument/);
  });
});
