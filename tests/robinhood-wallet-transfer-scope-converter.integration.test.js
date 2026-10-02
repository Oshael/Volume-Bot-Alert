process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, beforeEach, afterEach, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const stages = [256, 258, 262, 263].map((n) => require(`../src/utils/db-init-stage${n}`));
const { convertScopeHistory } = require('../src/models/robinhood-wallet-transfer-scope-converter');
const { main } = require('../src/utils/convert-robinhood-wallet-transfer-scope-history');
const { decodeScopeBitmap } = require('../src/models/robinhood-wallet-transfer-scope-bitmap');
const tokens = [1, 2, 3].map((n) => `0x${n.toString(16).padStart(40, '0')}`);
const input = { projectionVersion: 'convert', stream: 'live', maxRanges: 10 };
let client; let schema;
const database = { getClient: async () => ({ query: (...args) => client.query(...args), release() {} }) };
async function source(members = tokens, hashed = false, scopeId = null) {
  const hash = createHash('sha256').update([...members].sort().join('\n')).digest('hex');
  if (hashed) await client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes(chain,scope_hash,token_addresses)
    VALUES ('robinhood',$1,$2) ON CONFLICT DO NOTHING`, [hash, members]);
  const row = (await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
    (chain,projection_version,stream,from_block,through_block,checkpoint_hash,filter_mode,token_addresses,token_scope_hash,scope_id)
    VALUES ('robinhood','convert','live',10,11,$1,'topics-only',$2,$3,$4) RETURNING scan_scope_id::text AS id`,
  [`0x${'f'.repeat(64)}`, hashed ? null : members, hashed ? hash : null, scopeId])).rows[0];
  return { id: row.id, hash };
}
async function count(table) { return (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n; }
const dictionaryCount = () => count('robinhood_wallet_transfer_scope_dictionary');
async function saved(hash) {
  const row = (await client.query('SELECT * FROM robinhood_wallet_transfer_scope_bitmap_staging WHERE scope_hash=$1', [hash])).rows[0];
  const dictionary = (await client.query('SELECT token_address,ordinal FROM robinhood_wallet_transfer_scope_dictionary')).rows;
  return { row, tokens: decodeScopeBitmap({ bitmap: row.scope_bitmap, dictionarySize: row.dictionary_size,
    tokenCount: row.bitmap_token_count, scopeHash: row.scope_hash }, dictionary) };
}
async function protectLegacy() {
  await client.query(`CREATE FUNCTION forbid_legacy_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'legacy scope write forbidden during preparation'; END $$`);
  await client.query(`CREATE TRIGGER forbid_legacy_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
    ON robinhood_wallet_transfer_token_scopes FOR EACH STATEMENT EXECUTE FUNCTION forbid_legacy_write()`);
}
describe('Historical scope bitmap staging', () => {
  before(async () => { await assertUsingTestDatabase(db); client = await db.getClient(); });
  beforeEach(async () => {
    schema = `test_converter_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
    for (const stage of stages) for (const sql of stage.STATEMENTS) await client.query(sql);
    await client.query('ALTER TABLE robinhood_wallet_transfer_scan_scopes ADD COLUMN scope_id bigint');
    await client.query('CREATE TABLE robinhood_chain_blocks(chain text,block_number bigint,block_hash text,canonical boolean)');
    await client.query("INSERT INTO robinhood_chain_blocks VALUES ('robinhood',11,$1,true)", [`0x${'f'.repeat(64)}`]);
  });
  afterEach(async () => { if (schema) await client.query(`DROP SCHEMA ${schema} CASCADE`); });
  after(async () => { client?.release(); await db.pool.end(); });
  it('dry-runs inline and hash scopes in a read-only transaction without reserving IDs', async () => {
    await source(); await source(tokens.slice(1), true);
    const sequence = (await client.query(`SELECT pg_get_serial_sequence('robinhood_wallet_transfer_scope_dictionary','ordinal') AS name`)).rows[0].name;
    const before = (await client.query(`SELECT last_value,is_called FROM ${sequence}`)).rows;
    const readOnly = { getClient: async () => ({ release() {}, async query(sql, params) {
      const result = await client.query(sql, params);
      if (sql.startsWith('BEGIN')) assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      return result;
    } }) };
    const progress = []; const report = await convertScopeHistory(readOnly, input, (p) => progress.push(p));
    assert.equal(report.mode, 'dry-run'); assert.equal(report.stopReason, 'cohort-end');
    assert.deepEqual(report.measured.map((m) => m.source), ['inline', 'hashed']);
    assert.equal(progress.length, 2); assert.equal(await dictionaryCount(), 0);
    assert.equal(await count('robinhood_wallet_transfer_scope_bitmap_staging'), 0);
    assert.deepEqual((await client.query(`SELECT last_value,is_called FROM ${sequence}`)).rows, before);
    assert.equal((await client.query('SELECT scope_bitmap FROM robinhood_wallet_transfer_token_scopes')).rows[0].scope_bitmap, null);
  });
  it('stages exact membership including removal/reentry and deduplicates without changing source ranges', async () => {
    const first = await source(tokens.toReversed()); await source(tokens.slice(1), true); await source();
    const ranges = (await client.query('SELECT * FROM robinhood_wallet_transfer_scan_scopes ORDER BY scan_scope_id')).rows;
    const legacy = (await client.query('SELECT * FROM robinhood_wallet_transfer_token_scopes')).rows;
    await protectLegacy();
    const report = await main(['--projection-version=convert', '--stream=live', '--max-ranges=10', '--commit'],
      { database, logger: { log() {} } });
    assert.deepEqual(report.measured.map((r) => r.status), ['staged', 'staged', 'verified-existing']);
    assert.equal(await dictionaryCount(), 3); assert.equal(await count('robinhood_wallet_transfer_scope_bitmap_staging'), 2);
    assert.deepEqual((await client.query('SELECT * FROM robinhood_wallet_transfer_token_scopes')).rows, legacy);
    assert.ok(report.measured.every((r) => r.storage === 'staging'));
    assert.deepEqual((await saved(first.hash)).tokens, tokens);
    assert.deepEqual((await client.query('SELECT * FROM robinhood_wallet_transfer_scan_scopes ORDER BY scan_scope_id')).rows, ranges);
    const retry = await convertScopeHistory(database, { ...input, commit: true });
    assert.ok(retry.measured.every((r) => r.status === 'verified-existing' && r.dictionaryAdded === 0));
    assert.equal(await dictionaryCount(), 3);
  });
  it('resumes a bounded cohort and stops at versioned scopes without including new ranges', async () => {
    await source(); const second = await source(tokens.slice(1));
    const first = await convertScopeHistory(database, { ...input, commit: true, maxRanges: 1 });
    await source(tokens.slice(0, 1));
    const resumed = await convertScopeHistory(database, { ...input, commit: true, ...first.resume });
    assert.equal(resumed.measured.length, 1); assert.equal(resumed.measured[0].scanScopeId, second.id);
    await source(tokens, false, 7);
    const boundary = await convertScopeHistory(database, { ...input, commit: true });
    assert.equal(boundary.stopReason, 'versioned-boundary'); assert.equal(boundary.measured.length, 3);
  });
  it('rolls back dictionary/map writes on failure and safely retries burned identity gaps', async () => {
    const { hash } = await source();
    const failing = { getClient: async () => ({ release() {}, query(sql, params) {
      if (sql.startsWith('INSERT INTO robinhood_wallet_transfer_scope_bitmap_staging')) throw new Error('injected map failure');
      return client.query(sql, params);
    } }) };
    await assert.rejects(convertScopeHistory(failing, { ...input, commit: true }), /injected/);
    assert.equal(await dictionaryCount(), 0); assert.equal(await count('robinhood_wallet_transfer_token_scopes'), 0);
    assert.equal(await count('robinhood_wallet_transfer_scope_bitmap_staging'), 0);
    await convertScopeHistory(database, { ...input, commit: true });
    assert.deepEqual((await saved(hash)).tokens, tokens); assert.equal(await dictionaryCount(), 3);
  });
  it('stages a 414065-token hashed scope without legacy writes or new identity reservations on retry', async () => {
    const members = Array.from({ length: 414065 }, (_, n) => `0x${n.toString(16).padStart(40, '0')}`);
    const { hash } = await source(members, true);
    const legacy = (await client.query('SELECT * FROM robinhood_wallet_transfer_token_scopes')).rows;
    await protectLegacy();
    // Production already has 408623 dictionary entries; this hashed set adds 5442.
    for (let offset = 0; offset < 408623; offset += 5000) {
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address)
        SELECT 'robinhood',token FROM unnest($1::text[]) token ORDER BY token`,
      [members.slice(offset, Math.min(offset + 5000, 408623))]);
    }
    const first = await convertScopeHistory(database, { ...input, commit: true, budgetMs: 30000 });
    assert.equal(first.measured[0].dictionaryAdded, 5442);
    assert.deepEqual((await saved(hash)).tokens, members);
    const sequence = (await client.query(`SELECT pg_get_serial_sequence('robinhood_wallet_transfer_scope_dictionary','ordinal') AS name`)).rows[0].name;
    const reserved = (await client.query(`SELECT last_value,is_called FROM ${sequence}`)).rows;
    const retry = await convertScopeHistory(database, { ...input, commit: true, budgetMs: 30000 });
    assert.equal(retry.measured[0].dictionarySize, first.measured[0].dictionarySize);
    assert.equal(await dictionaryCount(), 414065);
    assert.deepEqual((await client.query(`SELECT last_value,is_called FROM ${sequence}`)).rows, reserved);
    assert.deepEqual((await client.query('SELECT * FROM robinhood_wallet_transfer_token_scopes')).rows, legacy);
  });
  it('reuses an already published legacy map without rewriting it or creating a duplicate staging map', async () => {
    const { hash } = await source(tokens, true);
    await client.query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address)
      SELECT 'robinhood',token FROM unnest($1::text[]) token ORDER BY token`, [tokens]);
    await client.query(`UPDATE robinhood_wallet_transfer_token_scopes SET scope_bitmap=$1,
      dictionary_size=3,bitmap_token_count=3 WHERE scope_hash=$2`, [Buffer.from([7]), hash]);
    await protectLegacy();
    const report = await convertScopeHistory(database, { ...input, commit: true });
    assert.equal(report.measured[0].storage, 'legacy');
    assert.equal(report.measured[0].status, 'verified-existing');
    assert.equal(report.measured[0].dictionaryAdded, 0);
    assert.equal(await count('robinhood_wallet_transfer_scope_bitmap_staging'), 0);
  });
  it('initializes staging idempotently and enforces bounded, immutable payloads', async () => {
    await stages.at(-1).init({ database, closePool: false });
    const { hash } = await source(); await convertScopeHistory(database, { ...input, commit: true });
    for (const sql of ['UPDATE robinhood_wallet_transfer_scope_bitmap_staging SET dictionary_size=3',
      'DELETE FROM robinhood_wallet_transfer_scope_bitmap_staging', 'TRUNCATE robinhood_wallet_transfer_scope_bitmap_staging']) {
      await assert.rejects(client.query(sql), /immutable/);
    }
    for (const [bitmap, size, count] of [[Buffer.from([15]), 3, 4], [Buffer.from([7]), 3, 2],
      [Buffer.alloc(0), 0, 1], [Buffer.alloc(1), 1000001, 1], [Buffer.from([7]), 3, 500001]]) {
      await assert.rejects(client.query(`INSERT INTO robinhood_wallet_transfer_scope_bitmap_staging
        (chain,scope_hash,scope_bitmap,dictionary_size,bitmap_token_count) VALUES ('robinhood',$1,$2,$3,$4)`,
      ['a'.repeat(64), bitmap, size, count]), /rh_transfer_bitmap_staging_payload/);
    }
    assert.deepEqual((await saved(hash)).tokens, tokens);
  });
  it('refuses corruption, oversized sources and noncanonical checkpoints before staging', async () => {
    await source(tokens, true);
    await assert.rejects(convertScopeHistory(database, { ...input, commit: true, maxTokens: 2 }), /oversized/);
    await client.query('UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=$1', [tokens.slice(1)]);
    await assert.rejects(convertScopeHistory(database, { ...input, commit: true }), /hash mismatch/);
    await client.query('UPDATE robinhood_chain_blocks SET canonical=false');
    await assert.rejects(convertScopeHistory(database, { ...input, commit: true }), /not canonical/);
    assert.equal(await dictionaryCount(), 0);
  });
  it('rejects published map corruption and exhausted dictionary identities without changing sources', async () => {
    const first = await source(); await convertScopeHistory(database, { ...input, commit: true });
    const second = await source(tokens.slice(1), true);
    await client.query(`UPDATE robinhood_wallet_transfer_token_scopes SET scope_bitmap=$1,
      dictionary_size=3,bitmap_token_count=2 WHERE scope_hash=$2`, [Buffer.from([3]), second.hash]);
    await assert.rejects(convertScopeHistory(database, { ...input, commit: true,
      afterId: first.id, highWaterId: second.id }), /membership mismatch/);
    await source([`0x${'e'.repeat(40)}`]);
    await client.query(`SELECT setval(pg_get_serial_sequence('robinhood_wallet_transfer_scope_dictionary','ordinal'),999999,true)`);
    await assert.rejects(convertScopeHistory(database, { ...input, commit: true, afterId: second.id, highWaterId: '3' }), /dictionary limit/);
    assert.equal(await dictionaryCount(), 3);
    assert.deepEqual((await client.query('SELECT token_addresses FROM robinhood_wallet_transfer_token_scopes WHERE scope_hash=$1', [second.hash])).rows[0].token_addresses, tokens.slice(1));
  });
  it('rejects a concurrent converter and retains completed progress if the next scope fails', async () => {
    const first = await source(); await source(tokens, true);
    const blocker = await db.getClient();
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(262,1)');
      await assert.rejects(convertScopeHistory(database, { ...input, commit: true }), /converter is active/);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    const progress = [];
    await assert.rejects(convertScopeHistory(database, { ...input, commit: true }, async (p) => {
      progress.push(p); await client.query('UPDATE robinhood_chain_blocks SET canonical=false');
    }), (error) => {
      assert.equal(error.conversionReport.resume.afterId, first.id); return /not canonical/.test(error.message);
    });
    assert.equal(progress.length, 1); assert.deepEqual((await saved(first.hash)).tokens, tokens);
  });
});
