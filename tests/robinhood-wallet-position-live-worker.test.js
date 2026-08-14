const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletPositionLiveWorker,
  __private: { runPositionLiveTick },
} = require('../src/services/robinhood-wallet-position-live-worker');

const TIME = '2026-08-14T12:00:00.000Z';

function options() {
  return { projectionVersion: 'swap_only_v1', maxBlocks: 50 };
}

function runtime(overrides = {}) {
  const initialized = [];
  const positions = {
    async loadCursor(_version, stream) {
      return stream === 'seed'
        ? { lifecycleState: 'complete', nextBlock: '100', nextBlockTime: TIME }
        : null;
    },
    async initCursor(input) {
      initialized.push(input);
      return { ...input, version: 0, lifecycleState: 'pending' };
    },
    async reconcileTouchedPositions() {
      return { checked: 1, aligned: 0, matching: 0, mismatched: 0, unaligned: 1 };
    },
  };
  return {
    initialized,
    positions,
    sourceCursors: { loadCursor: async () => ({
      lifecycleState: 'running', nextBlock: '121', checkpointTimestamp: TIME,
    }) },
    projector: { runBatch: async () => ({
      complete: false,
      touched: [{
        tokenAddress: `0x${'11'.repeat(20)}`,
        walletAddress: `0x${'22'.repeat(20)}`,
      }],
      persisted: { committed: true, cursor: { nextBlock: '111' } },
    }) },
    ...overrides,
  };
}

describe('Robinhood wallet position LIVE worker', () => {
  it('waits for the historical seed before creating LIVE state', async () => {
    const context = runtime();
    context.positions.loadCursor = async () => null;
    const result = await runPositionLiveTick(context, options());

    assert.equal(result.status, 'awaiting-seed');
    assert.equal(context.initialized.length, 0);
  });

  it('hands off from seed and uses only the durable source frontier', async () => {
    const context = runtime();
    let projectionInput;
    context.projector.runBatch = async (input) => {
      projectionInput = input;
      return {
        complete: false, touched: [],
        persisted: { committed: true, cursor: { nextBlock: '121' } },
      };
    };
    const result = await runPositionLiveTick(context, options());

    assert.equal(context.initialized[0].nextBlock, '100');
    assert.equal(context.initialized[0].safeHead, '120');
    assert.equal(projectionInput.cursor.safeHead, '120');
    assert.equal(projectionInput.emptyNextBlockTime, TIME);
    assert.equal(result.projectionThrough, '120');
  });

  it('keeps transfer-shaped mismatches provisional', async () => {
    const context = runtime();
    context.positions.reconcileTouchedPositions = async () => ({
      checked: 1, aligned: 1, matching: 0, mismatched: 1, unaligned: 0,
    });
    const result = await runPositionLiveTick(context, options());

    assert.equal(result.status, 'projected');
    assert.equal(result.quality, 'provisional-transfer-gap');
  });

  it('is disabled by default and schedules only when enabled', async () => {
    const scheduled = [];
    const worker = createRobinhoodWalletPositionLiveWorker({
      schedule: (fn, delay) => { const item = { fn, delay }; scheduled.push(item); return item; },
      cancelSchedule() {},
      runTick: async () => ({ status: 'caught-up', touched: [{}] }),
      positionRepositoryFactory: () => ({}),
      sourceCursorRepositoryFactory: () => ({}),
      projectorFactory: () => ({}),
    });
    assert.equal(worker.start(), false);
    assert.equal(worker.start({ enabled: true }), true);
    assert.equal(scheduled[0].delay, 0);
    await scheduled[0].fn();
    assert.equal(worker.getStatus().lastResult.touched, undefined);
    await worker.stop();
  });
});
