process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, after, afterEach, test } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { describeJournal, digest, namespace, receive } = require('../src/services/robinhood-holder-journal-receiver');
let client; let options; let pool; let manifest; const created = [];
const row = () => ({ chain: 'robinhood', transaction_hash: `0x${'a'.repeat(64)}`, log_index: '1',
  amount_raw: '9'.repeat(78), captured_at: '2026-09-04T13:00:00.123456Z', applied: false });
const batch = (runId, rows = [row()], fromPage = 0, toPage = 512) => ({ op: 'batch', runId,
  sourceIdentity: manifest.sourceIdentity, rows, checksum: digest(rows), fromPage, toPage });

before(async () => {
  await assertUsingTestDatabase(db); client = await db.pool.connect();
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  options = { database, write: true, template: 'pg_temp.robinhood_holder_transfer_journal' };
  pool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
  await client.query(`CREATE TEMP TABLE robinhood_holder_transfer_journal (
    chain text NOT NULL CHECK(chain = 'robinhood'), transaction_hash text NOT NULL, log_index integer NOT NULL,
    amount_raw numeric(78,0) NOT NULL CHECK(amount_raw >= 0), captured_at timestamptz NOT NULL, applied boolean NOT NULL,
    PRIMARY KEY(chain, transaction_hash, log_index));
    INSERT INTO robinhood_holder_transfer_journal VALUES ('robinhood','old-copy',0,1,NOW(),false)`);
  const description = await describeJournal(client.query.bind(client), options.template);
  manifest = { version: 1, sourceIdentity: 'a'.repeat(64), schemaHash: description.hash, fromPage: 0, endPage: 1024, pages: 512 };
});
afterEach(async () => {
  for (const runId of created.splice(0)) await client.query(`DROP SCHEMA ${namespace(runId)} CASCADE`);
});
after(async () => { if (client) { await client.query('DISCARD TEMP'); client.release(); } await db.pool.end(); });

async function initialize() {
  const runId = randomUUID(); const frame = { op: 'init', runId, manifest };
  const result = await receive(pool, frame, options); created.push(runId);
  assert.equal(result.outcome, 'initialized'); return frame;
}

test('isolated initialization is repeatable, rejects changed manifests and leaves old data intact', async () => {
  const frame = await initialize();
  assert.equal((await receive(pool, frame, options)).outcome, 'already_initialized');
  await assert.rejects(receive(pool, { ...frame, manifest: { ...manifest, endPage: 2048 } }, options), /different manifest/);
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${namespace(frame.runId)}.journal`)).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM robinhood_holder_transfer_journal')).rows[0].n, 1);
});

test('wrong database, missing write acknowledgement and schema mismatch create no destination', async () => {
  const frame = { op: 'init', runId: randomUUID(), manifest };
  await assert.rejects(receive(pool, frame, { ...options, database: 'wrong-db' }), /wrong destination/);
  await assert.rejects(receive(pool, frame, { ...options, write: false }), /acknowledgement/);
  await assert.rejects(receive(pool, { ...frame, manifest: { ...manifest, schemaHash: 'b'.repeat(64) } }, options), /schema mismatch/);
  assert.equal((await client.query('SELECT to_regnamespace($1) AS oid', [namespace(frame.runId)])).rows[0].oid, null);
});

test('data and checkpoint commit together, preserve precision and accept an empty terminal batch', async () => {
  const { runId } = await initialize(); const first = await receive(pool, batch(runId), options);
  assert.equal(first.nextPage, 512); assert.equal(first.receivedRows, '1'); assert.equal(first.readyForSwap, false);
  const stored = (await client.query(`SELECT amount_raw::text, to_char(captured_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at FROM ${namespace(runId)}.journal`)).rows[0];
  assert.equal(stored.amount_raw, row().amount_raw); assert.equal(stored.captured_at, row().captured_at);
  const end = await receive(pool, batch(runId, [], 512, 1024), options); assert.equal(end.nextPage, 1024);
  const report = await receive(pool, { op: 'status', runId }, { ...options, write: false });
  assert.equal(report.receivedRows, '1'); assert.equal(report.sourceConsistencyVerified, false);
});

test('concurrent identical retries insert once; conflicting replay and gaps are rejected', async () => {
  const { runId } = await initialize(); const frame = batch(runId);
  const outcomes = await Promise.all([receive(db.pool, frame, options), receive(db.pool, frame, options)]);
  assert.deepEqual(outcomes.map(r => r.outcome).sort(), ['already_committed', 'committed']);
  await assert.rejects(receive(pool, { ...frame, sourceIdentity: 'b'.repeat(64) }, options), /source identity mismatch/);
  await assert.rejects(receive(pool, batch(runId, [{ ...row(), amount_raw: '2' }]), options), /conflicting replay/);
  await assert.rejects(receive(pool, batch(runId, [], 1024, 1536), options), /gap, overlap/);
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${namespace(runId)}.journal`)).rows[0].n, 1);
});

test('constraint and column errors roll back without advancing the checkpoint', async () => {
  const { runId } = await initialize();
  const missing = row(); delete missing.captured_at;
  for (const bad of [missing, { ...row(), amount_raw: '-1' }, { ...row(), extra: 'lost' }, { ...row(), log_index: 1 }]) {
    await assert.rejects(receive(pool, batch(runId, [row(), bad]), options));
  }
  const report = await receive(pool, { op: 'status', runId }, options);
  assert.equal(report.nextPage, 0); assert.equal(report.receivedRows, '0');
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${namespace(runId)}.journal`)).rows[0].n, 0);
});

test('destination schema drift is rejected before inserting a batch', async () => {
  const { runId } = await initialize();
  await client.query(`ALTER TABLE ${namespace(runId)}.journal ADD COLUMN extra text`);
  await assert.rejects(receive(pool, batch(runId), options), /schema changed/);
  assert.equal((await receive(pool, { op: 'status', runId }, options)).nextPage, 0);
});

test('interrupt after insertion rolls back data and leaves the batch retryable', async () => {
  const { runId } = await initialize(); const controller = new AbortController();
  const interrupted = { connect: async () => ({ release() {}, async query(sql, values) {
    const result = await client.query(sql, values);
    if (sql.startsWith(`INSERT INTO ${namespace(runId)}.journal`)) controller.abort();
    return result;
  } }) };
  await assert.rejects(receive(interrupted, batch(runId), { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${namespace(runId)}.journal`)).rows[0].n, 0);
  assert.equal((await receive(pool, batch(runId), options)).outcome, 'committed');
});

for (const afterCommit of [false, true]) test(`connection failure ${afterCommit ? 'after' : 'before'} commit is replay-safe`, async () => {
  const { runId } = await initialize(); const frame = batch(runId);
  const faulty = { connect: async () => ({ release() {}, async query(sql, values) {
    if (!afterCommit && sql.startsWith(`INSERT INTO ${namespace(runId)}.batches`)) throw new Error('lost connection');
    const result = await client.query(sql, values);
    if (afterCommit && sql === 'COMMIT') throw new Error('lost acknowledgement');
    return result;
  } }) };
  await assert.rejects(receive(faulty, frame, options), /lost/);
  const retry = await receive(pool, frame, options);
  assert.equal(retry.outcome, afterCommit ? 'already_committed' : 'committed');
  assert.equal(retry.receivedRows, '1');
});
