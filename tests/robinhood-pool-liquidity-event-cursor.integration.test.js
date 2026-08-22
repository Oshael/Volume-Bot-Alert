process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage148 = require('../src/utils/db-init-stage148');
const {
  createRobinhoodPoolLiquidityEventCursorRepository,
} = require('../src/models/robinhood-pool-liquidity-event-cursor');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'b'.repeat(64)}`;

describe('Robinhood liquidity event cursor persistence integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage148.init({ closePool: false });
    await stage148.init({ closePool: false });
    await db.query("DELETE FROM robinhood_pool_liquidity_event_cursors WHERE chain = 'robinhood'");
  });

  after(async () => {
    await db.query("DELETE FROM robinhood_pool_liquidity_event_cursors WHERE chain = 'robinhood'");
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
});
