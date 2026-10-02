process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, beforeEach, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const stage256 = require('../src/utils/db-init-stage256');
const stage258 = require('../src/utils/db-init-stage258');
const stage262 = require('../src/utils/db-init-stage262');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { encodeScopeBitmap } = require('../src/models/robinhood-wallet-transfer-scope-bitmap');
const { auditScopeHistory } = require('../src/models/robinhood-wallet-transfer-scope-history-audit');
const schema = `test_scope_audit_${randomUUID().replaceAll('-', '')}`;
const tokens = [1, 2, 3].map((id) => `0x${id.toString(16).padStart(40, '0')}`);
const input = { projectionVersion: 'audit', stream: 'live', maxRanges: 10 };
let client; let initialized = false; let readOnly;
const database = { getClient: async () => ({
  async query(sql, params) {
    const result = await client.query(sql, params);
    if (sql.startsWith('BEGIN')) readOnly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    return result;
  }, release() {},
}) };
async function range(from, through, members, reusable = false, scopeId = null) {
  const hash = createHash('sha256').update(members.join('\n')).digest('hex');
  if (reusable) await client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes
    (chain,scope_hash,token_addresses) VALUES ('robinhood',$1,$2) ON CONFLICT DO NOTHING`, [hash, members]);
  return (await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
    (chain,projection_version,stream,from_block,through_block,checkpoint_hash,token_addresses,token_scope_hash,filter_mode,scope_id)
    VALUES ('robinhood','audit','live',$1,$2,$3,$4,$5,'topics-only',$6) RETURNING scan_scope_id::text AS id`,
  [from, through, `0x${'f'.repeat(64)}`, reusable ? null : members, reusable ? hash : null, scopeId])).rows[0].id;
}
describe('Read-only historical scope audit', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query(`CREATE SCHEMA ${schema}`);
    initialized = true;
    await client.query(`SET search_path TO ${schema}`);
    for (const stage of [stage256, stage258, stage262]) for (const sql of stage.STATEMENTS) await client.query(sql);
    // The auditor only consumes this Stage 259 identity field, not its writer contract.
    await client.query('ALTER TABLE robinhood_wallet_transfer_scan_scopes ADD COLUMN scope_id bigint');
  });
  beforeEach(async () => {
    await client.query('TRUNCATE robinhood_wallet_transfer_scan_scopes,robinhood_wallet_transfer_token_scopes CASCADE');
  });
  after(async () => {
    if (initialized) await client.query(`DROP SCHEMA ${schema} CASCADE`);
    client?.release();
    await db.pool.end();
  });
  it('measures inline/hash transitions and reentry without modifying source rows', async () => {
    await range(10, 11, tokens);
    await range(12, 13, tokens, true);
    await range(14, 15, tokens.slice(1), true);
    await range(16, 17, tokens);
    const report = await auditScopeHistory(database, input);
    assert.equal(readOnly, 'on');
    assert.equal(report.stopReason, 'cohort-end');
    assert.deepEqual(report.totals, { ranges: 4, bases: 1, versions: 3, unchangedRanges: 1, gaps: 0,
      tokenOccurrences: 11, membershipRows: 4, added: 1, removed: 1 });
    assert.equal((await client.query('SELECT count(*)::int AS count FROM robinhood_wallet_transfer_scan_scopes')).rows[0].count, 4);
  });
  it('audits compact references and enforces additive schema bounds and immutability', async () => {
    for (const sql of stage262.STATEMENTS) await client.query(sql);
    const group = SCHEMA_GROUPS.find((g) => g.key === 'stage262-robinhood-transfer-scope-bitmaps');
    for (const table of group.tables) {
      const columns = (await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass', [table.table])).rows;
      for (const column of table.columns) assert.ok(columns.some((r) => r.attname === column), column);
      const constraints = (await client.query('SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass', [table.table])).rows;
      for (const expected of table.constraints) assert.ok(constraints.some((r) => r.conname === expected.name
        && expected.includes.every((p) => r.definition.includes(p))), expected.name);
      const triggers = (await client.query('SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid=$1::regclass', [table.table])).rows;
      for (const expected of table.triggers) assert.ok(triggers.some((r) => r.tgname === expected.name
        && expected.includes.every((p) => r.definition.includes(p))), expected.name);
      for (const index of table.indexes || []) assert.ok((await client.query('SELECT to_regclass($1) AS oid', [index.name])).rows[0].oid);
    }
    await range(10, 11, tokens);
    await range(12, 13, tokens.slice(1), true);
    const dictionary = (await client.query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address)
      SELECT 'robinhood',token FROM unnest($1::text[]) token RETURNING token_address,ordinal`, [tokens])).rows;
    const encoded = encodeScopeBitmap(tokens.slice(1), dictionary);
    await client.query(`UPDATE robinhood_wallet_transfer_token_scopes SET scope_bitmap=$1,
      dictionary_size=$2,bitmap_token_count=$3 WHERE scope_hash=$4`,
    [encoded.bitmap, encoded.dictionarySize, encoded.tokenCount, encoded.scopeHash]);
    // Stage alone preserves both payloads; removal here is only an isolated test fixture.
    assert.deepEqual((await client.query('SELECT token_addresses FROM robinhood_wallet_transfer_token_scopes')).rows[0].token_addresses, tokens.slice(1));
    await client.query('UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=NULL');
    const report = await auditScopeHistory(database, input);
    assert.equal(report.measured[1].hash, encoded.scopeHash);
    assert.equal(report.totals.removed, 1);
    for (const sql of ['UPDATE robinhood_wallet_transfer_scope_dictionary SET ordinal=DEFAULT',
      'DELETE FROM robinhood_wallet_transfer_scope_dictionary', 'TRUNCATE robinhood_wallet_transfer_scope_dictionary',
      "UPDATE robinhood_wallet_transfer_token_scopes SET scope_bitmap='\\x01'::bytea"]) {
      await assert.rejects(client.query(sql), /immutable/);
    }
    for (const [bitmap, size, count] of [[encoded.bitmap, 1000001, 2], [encoded.bitmap, 3, 500001],
      [null, 3, 2], [Buffer.from([128]), 1, 1], [Buffer.alloc(0), 1, 1], [encoded.bitmap, 3, 1]]) {
      await assert.rejects(client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes
        (chain,scope_hash,token_addresses,scope_bitmap,dictionary_size,bitmap_token_count)
        VALUES ('robinhood',repeat('0',64),NULL,$1,$2,$3)`, [bitmap, size, count]), /constraint/);
    }
  });
  it('resumes without counting the anchor twice and excludes newly appended rows', async () => {
    await range(10, 11, tokens);
    await range(12, 13, tokens.slice(1), true);
    const whole = await auditScopeHistory(database, input);
    const partial = await auditScopeHistory(database, { ...input, maxRanges: 1 });
    await range(14, 15, tokens);
    const resumed = await auditScopeHistory(database, { ...input, resume: JSON.parse(JSON.stringify(partial.resume)) });
    assert.deepEqual(resumed.totals, whole.totals);
    assert.equal(resumed.measured.length, 1);
  });
  it('rejects a structurally valid bitmap whose reconstructed source hash differs', async () => {
    await range(10, 11, tokens.slice(1), true);
    await client.query(`UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=NULL,
      scope_bitmap=$1,dictionary_size=3,bitmap_token_count=2`, [Buffer.from([3])]);
    await assert.rejects(auditScopeHistory(database, input), /hash mismatch/);
  });
  it('starts a separate base after a gap and rejects overlapping ranges', async () => {
    await range(10, 11, tokens);
    await range(13, 14, tokens.slice(1));
    const report = await auditScopeHistory(database, input);
    assert.equal(report.totals.gaps, 1);
    assert.equal(report.totals.bases, 2);
    assert.equal(report.totals.membershipRows, 5);
    await range(14, 15, tokens);
    await assert.rejects(auditScopeHistory(database, input), /overlapping/);
  });
  it('rejects stale resume anchors, a changed cohort and invalid limits', async () => {
    const id = await range(10, 11, tokens);
    const report = await auditScopeHistory(database, input);
    await client.query('UPDATE robinhood_wallet_transfer_scan_scopes SET token_addresses=$2 WHERE scan_scope_id=$1', [id, tokens.slice(1)]);
    await assert.rejects(auditScopeHistory(database, { ...input, resume: report.resume }), /anchor changed/);
    await assert.rejects(auditScopeHistory(database, { ...input, stream: 'seed', resume: report.resume }), /resume identity/);
    for (const limit of [{ maxRanges: 101 }, { maxTokens: 500001 }, { budgetMs: 0 }]) {
      await assert.rejects(auditScopeHistory(database, { ...input, ...limit }), /invalid/);
    }
  });
  it('fails safely on corrupt hashes or oversized arrays, leaving the connection usable', async () => {
    await range(10, 11, tokens, true);
    await client.query('UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=$1', [tokens.slice(1)]);
    await assert.rejects(auditScopeHistory(database, input), /hash mismatch/);
    await client.query('UPDATE robinhood_wallet_transfer_token_scopes SET token_addresses=$1', [tokens]);
    await assert.rejects(auditScopeHistory(database, { ...input, maxTokens: 2 }), /oversized/);
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
  });
  it('stops explicitly at a versioned boundary instead of inventing historical membership', async () => {
    await range(10, 11, tokens);
    await range(12, 13, tokens, false, 1);
    const report = await auditScopeHistory(database, input);
    assert.equal(report.stopReason, 'versioned-boundary');
    assert.equal(report.totals.ranges, 1);
  });
});
