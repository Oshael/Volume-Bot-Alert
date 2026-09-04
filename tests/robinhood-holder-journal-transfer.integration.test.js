process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, after, test } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { runTransfer } = require('../src/services/robinhood-holder-journal-transfer');
let client; let database; let pool;

before(async () => {
  await assertUsingTestDatabase(db); client = await db.pool.connect();
  database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  pool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
  await client.query(`CREATE TEMP TABLE robinhood_holder_transfer_journal
      (chain text NOT NULL CHECK(chain='robinhood'), token_address text NOT NULL,
       block_number bigint NOT NULL, amount_raw numeric(78,0) NOT NULL, captured_at timestamptz NOT NULL,
       applied boolean NOT NULL CHECK(applied IN (true,false)));
    CREATE TEMP TABLE robinhood_holder_token_states(chain text,token_address text,ledger_status text);
    CREATE TEMP TABLE robinhood_holder_global_backfill_tokens(chain text,token_address text,status text,run_id int);
    CREATE TEMP TABLE robinhood_holder_global_backfill_runs(chain text,id int,status text,barrier_block bigint);
    CREATE TEMP TABLE robinhood_holder_cursors(chain text,stream text,next_block bigint,journal_floor_block bigint,updated_at timestamptz);
    CREATE TEMP TABLE worker_leases(lease_key text,lease_until timestamptz);
    INSERT INTO robinhood_holder_cursors VALUES('robinhood','live',100000,0,NOW());
    INSERT INTO robinhood_holder_token_states VALUES('robinhood','protected','live');
    INSERT INTO robinhood_holder_transfer_journal VALUES
      ('robinhood','recent',80000,999999999999999999999999999999,NOW(),true),
      ('robinhood','protected',1,1,NOW(),false), ('robinhood','discard',1,1,NOW(),true);
    ANALYZE robinhood_holder_transfer_journal`);
});
after(async () => { if (client) { await client.query('DISCARD TEMP'); client.release(); } await db.pool.end(); });

function transport() {
  const frames = [];
  return { frames, closed: false, async send(frame) {
    frames.push(frame);
    if (frame.op === 'init') return { outcome: 'initialized', manifest: frame.manifest, nextPage: 0 };
    return { outcome: 'committed', nextPage: frame.toPage, receivedRows: String(frame.rows.length) };
  }, async close() { this.closed = true; } };
}

test('one locked range sends only retained rows with lossless text and closes cleanly', async () => {
  const remote = transport(); let clock = 0;
  const result = await runTransfer(pool, { database, runId: randomUUID(), fromPage: 0, endPage: 1,
    pauseMs: 100, schema: 'pg_temp', write: true, allowHolderLock: true }, {
    transport: remote, clock: () => clock, sleep: async ms => { clock += ms; },
    observeBaseline: async () => ({ at: Date.now(), owner: 'test', errors: 0, streams: {} }),
    observeRecovery: async () => {},
  });
  assert.equal(result.status, 'transferred_unverified'); assert.equal(result.batches, 1);
  assert.equal(result.rows, 2); assert.equal(result.readyForSwap, false); assert.equal(remote.closed, true);
  const rows = remote.frames.find(frame => frame.op === 'batch').rows;
  assert.deepEqual(rows.map(row => row.token_address).sort(), ['protected', 'recent']);
  assert.equal(rows.find(row => row.token_address === 'recent').amount_raw, '999999999999999999999999999999');
  assert.equal(typeof rows[0].captured_at, 'string'); assert.equal(typeof rows[0].applied, 'string');
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
});

test('active holder worker fails before remote initialization and releases transaction', async () => {
  await client.query("INSERT INTO worker_leases VALUES('robinhood-holder-live-worker',NOW()+INTERVAL '1 minute')");
  const remote = transport();
  try {
    await assert.rejects(runTransfer(pool, { database, runId: randomUUID(), fromPage: 0, endPage: 1,
      pauseMs: 100, schema: 'pg_temp', write: true, allowHolderLock: true }, { transport: remote }), /holder worker active/);
    assert.equal(remote.frames.length, 0);
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
  } finally { await client.query('TRUNCATE worker_leases'); }
});

test('existing remote progress is refused instead of resuming after a lost source lock', async () => {
  const remote = transport(); remote.send = async frame => frame.op === 'init'
    ? { outcome: 'already_initialized', manifest: frame.manifest, nextPage: 1 } : null;
  await assert.rejects(runTransfer(pool, { database, runId: randomUUID(), fromPage: 0, endPage: 1,
    pauseMs: 100, schema: 'pg_temp', write: true, allowHolderLock: true }, { transport: remote }), /CTID resume is refused/);
});
