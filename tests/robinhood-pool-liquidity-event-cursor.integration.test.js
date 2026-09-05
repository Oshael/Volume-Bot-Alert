process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage63 = require('../src/utils/db-init-stage63');
const stage148 = require('../src/utils/db-init-stage148');
const stage197 = require('../src/utils/db-init-stage197');
const {
  createRobinhoodPoolLiquidityEventCursorRepository,
} = require('../src/models/robinhood-pool-liquidity-event-cursor');
const {
  createRobinhoodPoolLiquidityRefreshQueue,
} = require('../src/models/robinhood-pool-liquidity-refresh-queue');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'a'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v2:${ADDRESS}`;

async function clearState() {
  await db.query("DELETE FROM robinhood_pool_liquidity_refresh_queue WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_pool_liquidity_event_cursors WHERE chain='robinhood'");
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key=$1', [MARKET]);
}

async function insertPool() {
  await db.query(
    `INSERT INTO robinhood_pool_registry(
       chain, protocol, market_key, pool_address, token_address, quote_address,
       currency0, currency1, discovery_block, discovery_block_hash,
       discovery_tx_hash, discovery_log_index, discovered_at
     ) VALUES ('robinhood', 'uniswap-v2', $1, $2, $2, $3, $2, $3,
               1, $4, $4, 0, NOW())`,
    [MARKET, ADDRESS, `0x${'c'.repeat(40)}`, HASH]
  );
}

describe('Robinhood liquidity event cursor persistence integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage148.init({ closePool: false });
    await stage197.init({ closePool: false });
    await stage197.init({ closePool: false });
  });

  beforeEach(clearState);

  after(async () => {
    await clearState();
    await db.pool.end();
  });

  it('persists contiguous progress and an explicit reorg rewind', async () => {
    const repository = createRobinhoodPoolLiquidityEventCursorRepository({ database: db });
    await repository.resolveProcessingFrontier();
    const initial = await repository.initializeCursor({ startBlock: '100' });
    assert.equal(initial.coverageStartBlock, '100');
    assert.equal(initial.nextBlock, '100');
    await assert.rejects(
      repository.initializeCursor({ startBlock: '99' }),
      (error) => error.code === 'liquidity_event_cursor_conflict'
    );

    const committed = await repository.commitRange({
      fromBlock: '100', nextBlock: '111', safeHead: '120',
      checkpoint: { number: '110', hash: HASH, timestampMs: 1787400000000 },
    });
    assert.equal(committed.nextBlock, '111');
    assert.equal(committed.checkpoint.number, '110');

    await assert.rejects(repository.commitRange({
      fromBlock: '100', nextBlock: '105', safeHead: '120',
      checkpoint: { number: '104', hash: HASH },
    }), (error) => error.code === 'liquidity_event_cursor_conflict');

    const rewound = await repository.rewindCursor({ rewindBlock: '105' });
    assert.equal(rewound.nextBlock, '105');
    assert.equal(rewound.checkpoint, null);
    assert.equal((await repository.loadCursor()).nextBlock, '105');
  });

  it('atomically coalesces dirty pools and preserves a newer generation in flight', async () => {
    await insertPool();
    const cursor = createRobinhoodPoolLiquidityEventCursorRepository({ database: db });
    await cursor.initializeCursor({ startBlock: '100' });
    const queue = createRobinhoodPoolLiquidityRefreshQueue({ database: db });
    assert.deepEqual(await queue.commitScannedRange({
      fromBlock: '100', nextBlock: '111', safeHead: '120',
      checkpoint: { number: '110', hash: HASH, timestampMs: 1 },
      pools: [{ protocol: 'uniswap-v2', marketKey: MARKET }],
    }), { queued: 1, nextBlock: '111' });
    const first = (await queue.claim({ owner: 'worker-1', limit: 1, leaseMs: 60_000 }))[0];
    assert.equal(first.generation, '1');

    await queue.commitScannedRange({
      fromBlock: '111', nextBlock: '121', safeHead: '120',
      checkpoint: { number: '120', hash: HASH, timestampMs: 2 },
      pools: [{ protocol: 'uniswap-v2', marketKey: MARKET }],
    });
    assert.deepEqual(await queue.complete({
      owner: 'worker-1', protocol: 'uniswap-v2', marketKey: MARKET, generation: 1,
    }), { removed: false, requeued: true });
    const second = (await queue.claim({ owner: 'worker-2', limit: 1, leaseMs: 60_000 }))[0];
    assert.equal(second.generation, '2');
    assert.deepEqual(await queue.complete({
      owner: 'worker-2', protocol: 'uniswap-v2', marketKey: MARKET, generation: 2,
    }), { removed: true, requeued: false });
  });

  it('rolls back dirty marks when the cursor cannot advance', async () => {
    await insertPool();
    const cursor = createRobinhoodPoolLiquidityEventCursorRepository({ database: db });
    await cursor.initializeCursor({ startBlock: '121' });
    const queue = createRobinhoodPoolLiquidityRefreshQueue({ database: db });
    await assert.rejects(queue.commitScannedRange({
      fromBlock: '100', nextBlock: '101', safeHead: '120',
      checkpoint: { number: '100', hash: HASH },
      pools: [{ protocol: 'uniswap-v2', marketKey: MARKET }],
    }), (error) => error.code === 'liquidity_event_cursor_conflict');
    const count = await db.query(
      'SELECT COUNT(*)::int AS total FROM robinhood_pool_liquidity_refresh_queue'
    );
    assert.equal(count.rows[0].total, 0);
  });
});
