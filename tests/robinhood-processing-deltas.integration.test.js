process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodPersistenceRepository } = require('../src/models/robinhood-persistence');
const stages = [63, 99, 101].flatMap((id) => require(`../src/utils/db-init-stage${id}`).STATEMENTS);
const HASH = `0x${'a'.repeat(64)}`;
const POOL = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'c'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v4:${POOL}`;
const RANGE_ERROR = /V4 liquidity range update conflicted or became negative/;
let client;
let repository;

function delta(index, amount) {
  return {
    log: {
      blockNumber: '100', blockHash: HASH, transactionHash: HASH,
      logIndex: String(index), topics: [HASH], data: '0x',
    },
    event: {
      kind: 'modify-liquidity', protocol: 'uniswap-v4', marketKey: MARKET,
      poolId: POOL, sender: ADDRESS, tickLower: -60, tickUpper: 60,
      liquidityDelta: String(amount), salt: HASH, timestampMs: 1750000000000,
    },
  };
}

async function seedRange(amount) {
  if (amount == null) return;
  await client.query(`INSERT INTO robinhood_v4_liquidity_ranges
    (pool_id, market_key, tick_lower, tick_upper, liquidity_gross)
    VALUES ($1, $2, -60, 60, $3)`, [POOL, MARKET, String(amount)]);
}

async function ledgerState() {
  const { rows } = await client.query(`SELECT
    (SELECT COUNT(*)::int FROM robinhood_processed_logs) AS logs,
    (SELECT COUNT(*)::int FROM robinhood_v4_liquidity_deltas) AS deltas,
    COALESCE((SELECT liquidity_gross::text FROM robinhood_v4_liquidity_ranges
      WHERE pool_id = $1 AND tick_lower = -60 AND tick_upper = 60), '0') AS balance`, [POOL]);
  return rows[0];
}

describe('Robinhood processing consecutive V4 deltas integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    // Production DDL, connection-local tables: never truncate the shared fixtures.
    const names = new Set(['robinhood_processed_logs', 'robinhood_v4_liquidity_deltas',
      'robinhood_v4_liquidity_ranges', 'robinhood_v4_liquidity_materialization_state']);
    for (const sql of stages) {
      if (names.has(sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)?.[1])) {
        await client.query(sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
      }
    }
    repository = createRobinhoodPersistenceRepository({ database: {
      getClient: async () => ({ query: client.query.bind(client), release() {} }),
    } });
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE pg_temp.robinhood_processed_logs,
      pg_temp.robinhood_v4_liquidity_deltas, pg_temp.robinhood_v4_liquidity_ranges,
      pg_temp.robinhood_v4_liquidity_materialization_state`);
    await client.query(`INSERT INTO robinhood_v4_liquidity_materialization_state
      (replay_start_block, replay_target_block, replay_checkpoint_hash) VALUES (0, 99, $1)`, [HASH]);
  });

  after(async () => {
    client?.release(true);
    await db.pool.end();
  });

  for (const [initial, amounts, balance] of [
    [null, [10, -4], '6'], [null, [10, -10], '0'],
    ['90071992547409930', ['-90071992547409930', 2], '2'],
  ]) {
    it(`commits valid prefixes from ${initial} with net balance ${balance}, exactly once`, async () => {
      await seedRange(initial);
      const entries = amounts.map((amount, index) => delta(index, amount)).reverse();
      const first = await repository.commitHeadProcessingBatch({ entries });
      assert.equal(first.insertedLiquidityDeltas, 2);
      assert.deepEqual(await ledgerState(), { logs: 2, deltas: 2, balance });
      const replay = await repository.commitHeadProcessingBatch({ entries });
      assert.equal(replay.insertedLogs, 0);
      assert.equal(replay.insertedLiquidityDeltas, 0);
      assert.deepEqual(await ledgerState(), { logs: 2, deltas: 2, balance });
    });
  }

  for (const [initial, amounts] of [[null, [-5, 10]], [10, [-15, 15]], [10, [-15, 20]]]) {
    it(`rolls back a negative intermediate balance from ${initial} despite net delta ${amounts.reduce((a, b) => a + b)}`, async () => {
      await seedRange(initial);
      const entries = amounts.map((amount, index) => delta(index, amount)).reverse();
      await assert.rejects(repository.commitHeadProcessingBatch({ entries }), RANGE_ERROR);
      assert.deepEqual(await ledgerState(), { logs: 0, deltas: 0, balance: String(initial ?? 0) });
    });
  }

  it('excludes already committed deltas from prefix validation on partial replay', async () => {
    const first = delta(0, 10);
    const second = delta(1, -10);
    await repository.commitHeadProcessingBatch({ entries: [first] });
    const replay = await repository.commitHeadProcessingBatch({ entries: [second, first] });
    assert.equal(replay.insertedLogs, 1);
    assert.equal(replay.insertedLiquidityDeltas, 1);
    assert.deepEqual(await ledgerState(), { logs: 2, deltas: 2, balance: '0' });
  });
});
