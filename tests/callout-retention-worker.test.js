'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createCalloutRetentionWorker,
} = require('../src/services/callout-retention-worker');

function scheduler() {
  const scheduled = [];
  const cancelled = [];
  return {
    scheduled, cancelled,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule(timer) { cancelled.push(timer); },
  };
}

describe('callout retention worker', () => {
  it('deletes expired callouts in bounded batches and schedules the next tick', async () => {
    const clock = scheduler();
    const calls = [];
    const results = [
      { deletedCallouts: 1000, hasMore: true },
      { deletedCallouts: 7, hasMore: false },
    ];
    const worker = createCalloutRetentionWorker({
      ...clock,
      repository: {
        pruneExpiredCallouts: async (input) => { calls.push(input); return results.shift(); },
      },
    });

    assert.equal(worker.start({ intervalMs: 60_000, batchLimit: 1000, maxBatches: 3 }), true);
    await clock.scheduled[0].callback();

    assert.deepEqual(calls, [{ batchLimit: 1000 }, { batchLimit: 1000 }]);
    assert.deepEqual(worker.getStatus().lastResult, {
      status: 'pruned', batches: 2, deletedCallouts: 1007,
      batchBudgetExhausted: false,
    });
    assert.equal(worker.getStatus().totalDeletedCallouts, 1007);
    assert.equal(worker.getStatus().intervalMs, 60_000);
    assert.equal(clock.scheduled[1].delayMs, 60_000);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('reports backlog when the batch budget is exhausted', async () => {
    let calls = 0;
    const worker = createCalloutRetentionWorker({
      repository: { pruneExpiredCallouts: async () => {
        calls += 1;
        return { deletedCallouts: 25, hasMore: true };
      } },
    });

    const result = await worker.runOnce();

    assert.equal(calls, 5);
    assert.deepEqual(result, {
      status: 'draining', batches: 5, deletedCallouts: 125,
      batchBudgetExhausted: true,
    });
  });

  it('backs off after a transient failure and resumes the normal cadence', async () => {
    const clock = scheduler();
    let attempts = 0;
    const worker = createCalloutRetentionWorker({
      ...clock,
      logger: { warn() {} },
      repository: { pruneExpiredCallouts: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('database unavailable');
        return { deletedCallouts: 0, hasMore: false };
      } },
    });
    worker.start({ intervalMs: 10_000, maxErrorBackoffMs: 100_000 });

    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 20_000);
    await clock.scheduled[1].callback();
    assert.equal(clock.scheduled[2].delayMs, 10_000);
    assert.equal(worker.getStatus().consecutiveErrors, 0);
    assert.equal(worker.getStatus().totalErrors, 1);
    await worker.stop();
  });
});
