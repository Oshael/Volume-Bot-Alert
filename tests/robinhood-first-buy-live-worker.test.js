const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodFirstBuyLiveWorker,
} = require('../src/services/robinhood-first-buy-live-worker');

function harness(overrides = {}) {
  const scheduled = [];
  const calls = [];
  const worker = createRobinhoodFirstBuyLiveWorker({
    schedule(fn, delay) { const entry = { fn, delay }; scheduled.push(entry); return entry; },
    cancelSchedule() {},
    sourceCursorFactory: () => ({ source: true }),
    liveCursorFactory: () => ({ cursor: true }),
    writerFactory: () => ({ writer: true }),
    logger: { warn: (...args) => calls.push(['warn', ...args]), error: () => {} },
    runTick: overrides.runTick || (async (runtime, options) => {
      calls.push(['tick', runtime, options]);
      return {
        status: 'advanced', nextTime: '2026-08-22T00:05:00.000Z',
        sourceThrough: '2026-08-22T00:10:00.000Z',
        rowsScanned: 10, factsConsidered: 4, factsWritten: 3,
      };
    }),
  });
  return { calls, scheduled, worker };
}

describe('Robinhood first-buy LIVE worker', () => {
  it('is opt-in, runs independently and reports bounded telemetry', async () => {
    const context = harness();
    assert.equal(context.worker.start(), false);
    assert.equal(context.worker.start({
      enabled: true, seedRunId: 7, intervalMs: 1000, rangeSeconds: 600,
    }), true);
    assert.equal(context.scheduled[0].delay, 0);
    await context.scheduled[0].fn();
    const status = context.worker.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.totalRuns, 1);
    assert.equal(status.totalRowsScanned, 10);
    assert.equal(status.totalFactsWritten, 3);
    assert.equal(status.lagMs, 300_000);
    assert.equal(context.calls[0][2].seedRunId, '7');
    assert.equal(context.scheduled[1].delay, 1000);
    await context.worker.stop();
  });

  it('halts its lease owner when canonical evidence becomes unsafe', async () => {
    const fatal = Object.assign(new Error('position missing'), {
      code: 'first_buy_position_unavailable',
    });
    const context = harness({ runTick: async () => { throw fatal; } });
    const propagated = [];
    context.worker.start({
      enabled: true, seedRunId: 8, onFatal: async (error) => propagated.push(error),
    });
    await context.scheduled[0].fn();
    assert.deepEqual(propagated, [fatal]);
    assert.equal(context.worker.getStatus().halted, true);
    assert.equal(context.worker.getStatus().running, false);
    assert.equal(context.scheduled.length, 1);
  });

  it('requires a seed run and bounds runtime controls', async () => {
    const context = harness();
    assert.throws(() => context.worker.start({ enabled: true }), /seedRunId/);
    const second = harness();
    second.worker.start({
      enabled: true, seedRunId: 9, intervalMs: 1,
      maxErrorBackoffMs: 999_999, rangeSeconds: 999_999,
    });
    await second.scheduled[0].fn();
    assert.equal(second.calls[0][2].intervalMs, 250);
    assert.equal(second.calls[0][2].maxErrorBackoffMs, 300_000);
    assert.equal(second.calls[0][2].rangeSeconds, 86_400);
    await second.worker.stop();
  });
});
