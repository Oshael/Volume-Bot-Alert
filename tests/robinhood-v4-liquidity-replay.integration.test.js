process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodV4LiquidityReplayRepository,
} = require('../src/models/robinhood-v4-liquidity-replay');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const POOL = `0x${'c'.repeat(64)}`;
const ADDRESS = `0x${'d'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v4:${POOL}`;
let client;
let repository;

function event(liquidityDelta = '10') {
  return {
    kind: 'modify-liquidity', protocol: 'uniswap-v4', transactionHash: TX,
    logIndex: '1', blockNumber: '100', blockHash: HASH, poolId: POOL,
    marketKey: MARKET, sender: ADDRESS, tickLower: -60, tickUpper: 60,
    liquidityDelta, salt: HASH, timestampMs: '1750000000000',
  };
}

async function resetCursor() {
  await client.query(`TRUNCATE robinhood_v4_liquidity_replay_state`);
  await client.query(`INSERT INTO robinhood_v4_liquidity_replay_state (
    start_block, next_block, target_block, status
  ) VALUES (100, 100, 100, 'running')`);
}

describe('Robinhood V4 replay idempotency integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    for (const [stage, table] of [
      [50, 'worker_leases'], [99, 'robinhood_v4_liquidity_deltas'],
      [100, 'robinhood_v4_liquidity_replay_state'],
    ]) {
      const statements = require(`../src/utils/db-init-stage${stage}`).STATEMENTS;
      const ddl = statements.find((sql) => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table}`));
      await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    }
    repository = createRobinhoodV4LiquidityReplayRepository({ database: {
      getClient: async () => ({ query: client.query.bind(client), release() {} }),
    } });
  });

  beforeEach(async () => {
    await client.query('TRUNCATE worker_leases, robinhood_v4_liquidity_deltas');
    await resetCursor();
  });

  after(async () => {
    client?.release(true);
    await db.pool.end();
  });

  it('validates an existing identical delta without rewriting its tuple', async () => {
    const input = {
      fromBlock: '100', toBlock: '100', checkpointHash: HASH, events: [event()],
    };
    await repository.commitRange(input);
    const before = (await client.query(
      'SELECT ctid::text, xmin::text FROM robinhood_v4_liquidity_deltas'
    )).rows[0];
    await resetCursor();

    await repository.commitRange(input);

    const afterReplay = (await client.query(
      'SELECT ctid::text, xmin::text FROM robinhood_v4_liquidity_deltas'
    )).rows[0];
    assert.deepEqual(afterReplay, before);
  });

  it('rolls back the cursor when an existing identity has different evidence', async () => {
    await repository.commitRange({
      fromBlock: '100', toBlock: '100', checkpointHash: HASH, events: [event()],
    });
    await resetCursor();

    await assert.rejects(repository.commitRange({
      fromBlock: '100', toBlock: '100', checkpointHash: HASH, events: [event('11')],
    }), /conflicts with persisted V4 liquidity/);

    const state = (await client.query(
      'SELECT next_block, status FROM robinhood_v4_liquidity_replay_state'
    )).rows[0];
    assert.deepEqual({ nextBlock: String(state.next_block), status: state.status }, {
      nextBlock: '100', status: 'running',
    });
  });
});
