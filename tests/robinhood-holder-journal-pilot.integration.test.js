process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { runPilot, pilotSql, validatePlan } = require('../src/services/robinhood-holder-journal-pilot');
let client; let database; let pool;

before(async () => {
  await assertUsingTestDatabase(db);
  client = await db.pool.connect();
  database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  pool = { connect: async () => ({ query: client.query.bind(client), release() {} }),
    query: db.query };
  await client.query(`CREATE TEMP TABLE robinhood_holder_transfer_journal (
    chain text, token_address text, block_number bigint, applied boolean, payload text);
    CREATE TEMP TABLE robinhood_holder_token_states (chain text, token_address text, ledger_status text);
    CREATE TEMP TABLE robinhood_holder_global_backfill_tokens (chain text, token_address text, status text, run_id int);
    CREATE TEMP TABLE robinhood_holder_global_backfill_runs (chain text, id int, status text, barrier_block bigint);
    CREATE TEMP TABLE robinhood_holder_cursors (chain text, stream text, next_block bigint,
      journal_floor_block bigint, updated_at timestamptz);
    INSERT INTO robinhood_holder_cursors VALUES ('robinhood','live',100000,0,NOW());
    INSERT INTO robinhood_holder_token_states VALUES
      ('robinhood','protected','live'), ('robinhood','drifted','drifted');
    INSERT INTO robinhood_holder_global_backfill_runs VALUES ('robinhood',1,'running',90000);
    INSERT INTO robinhood_holder_global_backfill_tokens VALUES ('robinhood','campaign','active',1);
    INSERT INTO robinhood_holder_transfer_journal
      SELECT 'robinhood', token, block, applied, repeat('x',800) FROM (VALUES
      ('unknown',80000,true), ('protected',79999,true), ('protected',79999,false),
      ('unknown',79999,false), ('campaign',79999,false), ('drifted',79999,false)
      ) AS rows(token,block,applied);
    INSERT INTO robinhood_holder_transfer_journal
      SELECT 'robinhood','unknown',1,false,repeat('x',800) FROM generate_series(1,10000);
    ANALYZE robinhood_holder_transfer_journal;`);
});
after(async () => {
  if (client) { await client.query('DISCARD TEMP'); client.release(); }
  await db.pool.end();
});

test('real TID range plan selects boundary and protected pending rows in one heap page', async () => {
  const report = await runPilot(pool, { database, pages: 1, measure: true }, { schema: 'pg_temp' });
  assert.equal(report.cursor.cutoff, '80000');
  assert.equal(report.measurement.selectedRows, 3);
  assert.equal(report.measurement.scannedRows < 20, true);
  assert.equal(report.measurement.tempWrittenBlocks, 0);
  assert.equal(report.resumable, false);
  assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_holder_transfer_journal')).rows[0].n, 10006);
});

test('dry plan does not execute measurement, wrong database fails closed', async () => {
  const report = await runPilot(pool, { database, pages: 1 }, { schema: 'pg_temp' });
  assert.equal(report.measurement, undefined);
  await assert.rejects(runPilot(pool, { database: 'not-the-selected-db' }, { schema: 'pg_temp' }), /unexpected database/);
});

test('guard rejects a real sequential plan chosen when TID scan is discouraged', async () => {
  await client.query('SET enable_tidscan = off');
  try {
    const plan = await client.query(`EXPLAIN (FORMAT JSON) ${pilotSql('pg_temp')}`,
      ['(0,0)', '(1,0)', '80000']);
    assert.throws(() => validatePlan(plan.rows[0]['QUERY PLAN'][0]), /unsafe plan/);
  } finally { await client.query('RESET enable_tidscan'); }
});

for (const mode of ['timeout', 'interrupt']) test(`real backend ${mode} leaves no open transaction`, async () => {
  const controller = new AbortController(); const events = []; let timer;
  const slowPool = { query: db.query, connect: async () => ({ release() {}, query(sql, params) {
    if (sql.startsWith('EXPLAIN (ANALYZE')) {
      if (mode === 'interrupt') timer = setTimeout(() => controller.abort(), 50);
      // Fault injection: a real long-running backend operation, not a mocked cancellation.
      return client.query('SELECT pg_sleep(5)');
    }
    return client.query(sql, params);
  } }) };
  try {
    await assert.rejects(runPilot(slowPool, { database, pages: 1, measure: true,
      timeoutMs: mode === 'timeout' ? 100 : 3000 }, { schema: 'pg_temp', signal: controller.signal,
      progress: (event) => events.push(event) }), { code: '57014' });
    if (mode === 'interrupt') assert.equal(events.some((event) => event.cancelled === true), true);
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
  } finally { clearTimeout(timer); }
});

test('a concurrent pilot is refused without waiting on the source', async () => {
  const other = await db.pool.connect();
  try {
    await other.query("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('robinhood-holder-journal-pilot',0))");
    await assert.rejects(runPilot(pool, { database, pages: 1 }, { schema: 'pg_temp' }), /another pilot/);
  } finally { await other.query('ROLLBACK'); other.release(); }
});
