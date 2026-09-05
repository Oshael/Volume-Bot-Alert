process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { refreshExistingHotQueue } = require('../src/models/robinhood-holder-hot-queue');
const {
  createRobinhoodHolderLedgerRepository,
} = require('../src/models/robinhood-holder-ledger');
const { HOT_QUEUE_REPAIR_STATEMENTS, STATEMENTS: HOT_QUEUE_DDL } = require('../src/utils/db-init-stage180');
const { STATEMENTS: PENDING_INDEX_DDL } = require('../src/utils/db-init-stage121');
const schema = `test_holder_hot_${process.pid}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'2'.repeat(64)}`;
const ZERO = `0x${'0'.repeat(40)}`;
let apply;
let capture;
let created = false;

before(async () => {
  await assertUsingTestDatabase(db);
  apply = await db.getClient();
  capture = await db.getClient();
  await apply.query(`CREATE SCHEMA ${schema}`);
  created = true;
  for (const client of [apply, capture]) {
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query("SET statement_timeout = '5s'");
  }
  // A dedicated test schema permits real concurrent sessions without touching
  // shared fixtures. Use production table/index definitions and enqueue trigger.
  for (const table of [
    'robinhood_holder_token_states', 'robinhood_holder_transfer_journal',
    'robinhood_holder_cursors',
  ]) {
    await apply.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await apply.query(HOT_QUEUE_DDL[0]);
  await apply.query(PENDING_INDEX_DDL[0].replace(' CONCURRENTLY', ''));
  await apply.query(HOT_QUEUE_REPAIR_STATEMENTS[0]);
  await apply.query(`CREATE TRIGGER enqueue_hot AFTER INSERT ON robinhood_holder_transfer_journal
    REFERENCING NEW TABLE AS inserted_holder_transfers
    FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.enqueue_robinhood_holder_hot()`);
});

beforeEach(async () => {
  for (const client of [apply, capture]) await client.query('ROLLBACK');
  await apply.query(`TRUNCATE ${schema}.robinhood_holder_hot_queue,
    ${schema}.robinhood_holder_transfer_journal, ${schema}.robinhood_holder_token_states,
    ${schema}.robinhood_holder_cursors`);
  await apply.query(`INSERT INTO robinhood_holder_token_states
    (token_address, ledger_status, backfill_next_block) VALUES ($1, 'live', 1)`, [TOKEN]);
  await apply.query(`INSERT INTO robinhood_holder_cursors
    (chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
     journal_floor_block, buffer_floor_block)
    VALUES ('robinhood', 'live', 11, 10, 10, $1, 1, 1)`, [HASH]);
});

after(async () => {
  for (const client of [apply, capture]) await client?.query('ROLLBACK');
  if (created) await apply.query(`DROP SCHEMA ${schema} CASCADE`);
  apply?.release(true);
  capture?.release(true);
  await db.pool.end();
});

async function insertEvents(client, first, last = first) {
  await client.query(`INSERT INTO robinhood_holder_transfer_journal
    (block_number, block_hash, transaction_hash, transaction_index, log_index,
     token_address, from_wallet, to_wallet, amount_raw, captured_at)
    SELECT n, $1, $1, 0, n, $2, $3, $2, 1,
           to_timestamp(1700000000 + CASE WHEN n = 2 THEN -60 ELSE n END)
      FROM generate_series($4::int, $5::int) n`, [HASH, TOKEN, ZERO, first, last]);
}

async function markApplied(client, through) {
  await client.query(`UPDATE robinhood_holder_transfer_journal
    SET applied = true, applied_at = NOW(), holder_delta = 1,
        to_balance_before = 0, to_balance_after = 1
    WHERE block_number <= $1 AND applied = false`, [through]);
}

async function readQueue() {
  return (await apply.query(`SELECT first_pending_block, last_pending_block,
    first_enqueued_at FROM robinhood_holder_hot_queue WHERE token_address = $1`, [TOKEN])).rows;
}

async function waitUntilBlocked(observer, blockedClient) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await observer.query(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [blockedClient.processID]
    );
    if (rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('expected the concurrent operation to wait for the queue row lock');
}

function journalScans(node) {
  return [node, ...(node.Plans || []).flatMap(journalScans)];
}

it('refreshes a large pending tail through two bounded index probes and rolls back atomically', async () => {
  await insertEvents(apply, 1, 10000);
  await apply.query('ANALYZE robinhood_holder_transfer_journal');
  const beforeQueue = await readQueue();
  await apply.query('BEGIN');
  await markApplied(apply, 5000);
  let plan;
  const explainingClient = { async query(sql, params) {
    if (!sql.startsWith('WITH first_pending')) return apply.query(sql, params);
    const result = await apply.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    plan = result.rows[0]['QUERY PLAN'][0].Plan;
    return result;
  } };
  assert.equal(await refreshExistingHotQueue(explainingClient, TOKEN), true);
  assert.deepEqual(await readQueue(), [{
    first_pending_block: '5001', last_pending_block: '10000',
    first_enqueued_at: beforeQueue[0].first_enqueued_at,
  }]);
  const scans = journalScans(plan).filter((node) => (
    node['Relation Name'] === 'robinhood_holder_transfer_journal'
  ));
  assert.equal(scans.length, 2);
  for (const scan of scans) {
    assert.match(scan['Node Type'], /Index/);
    assert.equal(scan['Actual Rows'], 1);
  }
  await apply.query('ROLLBACK');
  assert.deepEqual(await readQueue(), beforeQueue);
  assert.equal((await apply.query(`SELECT COUNT(*)::int AS pending
    FROM robinhood_holder_transfer_journal WHERE applied = false`)).rows[0].pending, 10000);
});

it('takes a fresh snapshot after an enqueue already holding the queue lock commits', async () => {
  await insertEvents(apply, 1);
  await capture.query('BEGIN');
  await insertEvents(capture, 2);
  await apply.query('BEGIN');
  const refreshing = refreshExistingHotQueue(apply, TOKEN).catch((error) => error);
  await waitUntilBlocked(capture, apply);
  await capture.query('COMMIT');
  assert.equal(await refreshing, true);
  await apply.query('COMMIT');
  assert.deepEqual(await readQueue(), [{
    first_pending_block: '1', last_pending_block: '2',
    first_enqueued_at: new Date(1699999940000),
  }]);
});

it('an enqueue racing a drained ticket recreates it after commit, without losing the event', async () => {
  await insertEvents(apply, 1);
  await apply.query('BEGIN');
  await markApplied(apply, 1);
  assert.equal(await refreshExistingHotQueue(apply, TOKEN), true);
  assert.deepEqual(await readQueue(), []);
  const enqueuing = insertEvents(capture, 2).catch((error) => error);
  await waitUntilBlocked(apply, capture);
  await apply.query('COMMIT');
  assert.equal(await enqueuing, undefined);
  assert.deepEqual(await readQueue(), [{
    first_pending_block: '2', last_pending_block: '2',
    first_enqueued_at: new Date(1699999940000),
  }]);
});

it('leaves missing-ticket recovery to the ledger without inventing a new timestamp', async () => {
  await apply.query('BEGIN');
  assert.equal(await refreshExistingHotQueue(apply, TOKEN), false);
  assert.deepEqual(await readQueue(), []);
  await apply.query('COMMIT');
});

it('removes a stale selected ticket when its journal is already drained', async () => {
  await apply.query(`INSERT INTO robinhood_holder_hot_queue (
    chain, token_address, first_pending_block, last_pending_block,
    first_enqueued_at, last_enqueued_at
  ) VALUES ('robinhood', $1, 1, 1, NOW(), NOW())`, [TOKEN]);
  const repository = createRobinhoodHolderLedgerRepository({
    database: {
      async getClient() {
        return { query: apply.query.bind(apply), release() {} };
      },
    },
  });
  assert.deepEqual(await repository.applyNextPendingEvent({
    onlyTokenAddress: TOKEN, maxEvents: 25,
  }), { status: 'idle' });
  assert.deepEqual(await readQueue(), []);
});
