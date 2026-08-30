const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runFirstBuyLiveTick,
} = require('../src/services/robinhood-first-buy-live-runner');

const SOURCE_TIME = '2026-08-22T01:00:00.000Z';

function runtime(overrides = {}) {
  const calls = [];
  const cursor = {
    seedRunId: '7', nextTime: '2026-08-22T00:00:00.000Z',
    sourceThrough: '2026-08-22T00:00:00.000Z', sourceNextBlock: '100', version: 0,
  };
  return {
    calls,
    sourceCursors: { async loadRetentionGate() { return {
      valid: true, completeThroughBlock: '199',
      seed: { lifecycleState: 'complete' },
      live: { nextBlock: '200', checkpointTimestamp: SOURCE_TIME },
    }; } },
    liveCursor: {
      async loadCursor() { return cursor; },
      async initializeFromRun() { throw new Error('unexpected initialization'); },
      async advance(input) {
        calls.push(['advance', input]);
        return { ...cursor, nextTime: input.nextTime, sourceThrough: input.sourceThrough,
          sourceNextBlock: input.sourceNextBlock, version: 1 };
      },
    },
    writer: { async materializeRange(input) {
      calls.push(['write', input]);
      return { rowsScanned: 4, factsConsidered: 2, factsWritten: 2 };
    } },
    ...overrides,
  };
}

describe('Robinhood first-buy LIVE runner', () => {
  it('materializes one bounded range before advancing the durable cursor', async () => {
    const context = runtime();
    const result = await runFirstBuyLiveTick(context, { seedRunId: 7, rangeSeconds: 300 });
    assert.equal(result.status, 'advanced');
    assert.deepEqual(context.calls.map(([name]) => name), ['write', 'advance']);
    assert.deepEqual(context.calls[0][1], {
      rangeStart: '2026-08-22T00:00:00.000Z', rangeEnd: '2026-08-22T00:05:00.000Z',
    });
    assert.equal(context.calls[1][1].sourceThrough, '2026-08-22T01:00:00.001Z');
  });

  it('initializes only from the configured completed seed run', async () => {
    const context = runtime();
    context.liveCursor.loadCursor = async () => null;
    context.liveCursor.initializeFromRun = async (runId) => {
      context.calls.push(['initialize', runId]);
      return null;
    };
    const result = await runFirstBuyLiveTick(context, { seedRunId: 9 });
    assert.deepEqual(result, { status: 'awaiting-seed', seedRunId: '9' });
    assert.deepEqual(context.calls, [['initialize', '9']]);
  });

  it('persists a newer block frontier when the time frontier is already caught up', async () => {
    const context = runtime();
    context.liveCursor.loadCursor = async () => ({
      seedRunId: '7', nextTime: '2026-08-22T01:00:00.001Z',
      sourceThrough: '2026-08-22T01:00:00.001Z', sourceNextBlock: '100', version: 4,
    });
    const result = await runFirstBuyLiveTick(context, { seedRunId: 7 });
    assert.equal(result.status, 'caught-up');
    assert.equal(result.sourceNextBlock, '200');
    assert.deepEqual(context.calls, [['advance', {
      nextTime: '2026-08-22T01:00:00.001Z', sourceThrough: '2026-08-22T01:00:00.001Z',
      sourceNextBlock: '200', expectedVersion: 4,
    }]]);
  });

  it('waits for durable source coverage and fails closed on regression', async () => {
    const waiting = runtime({ sourceCursors: { async loadRetentionGate() {
      return { valid: false, reason: 'seed_incomplete' };
    } } });
    assert.deepEqual(await runFirstBuyLiveTick(waiting, { seedRunId: 7 }), {
      status: 'awaiting-source', reason: 'seed_incomplete',
    });
    const regressed = runtime();
    regressed.liveCursor.loadCursor = async () => ({
      seedRunId: '7', nextTime: '2026-08-22T02:00:00.000Z',
      sourceThrough: '2026-08-22T02:00:00.000Z', sourceNextBlock: '200', version: 0,
    });
    await assert.rejects(runFirstBuyLiveTick(regressed, { seedRunId: 7 }),
      (error) => error.code === 'source_frontier_regressed' && error.fatal === true);
  });
});
