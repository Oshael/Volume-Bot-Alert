const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderSnapshotWorker,
} = require('../src/services/robinhood-holder-snapshot-worker');

const NOW = Date.parse('2026-08-10T12:00:00.000Z');

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

describe('Robinhood holder snapshot worker', () => {
  it('prefers the set-based temporal projector when available', async () => {
    const clock = scheduler();
    const calls = [];
    const worker = createRobinhoodHolderSnapshotWorker({
      ...clock, now: () => NOW,
      repository: { materializeLiveTemporalSnapshots: async (input) => {
        calls.push(input);
        return { savedCount: 3, asOf: input.asOf };
      } },
    });

    worker.start({ enabled: true, isLiveReady: () => true });
    await clock.scheduled[0].callback();

    assert.deepEqual(calls, [{ asOf: '2026-08-10T12:00:00.000Z' }]);
    assert.equal(worker.getStatus().totalSaved, 3);
    await worker.stop();
  });

  it('stays opt-in and projects one bounded batch per tick', async () => {
    const clock = scheduler();
    const calls = [];
    const worker = createRobinhoodHolderSnapshotWorker({
      ...clock, now: () => NOW,
      repository: { syncLiveDailySnapshots: async (input) => {
        calls.push(input);
        return { savedCount: 3, asOf: input.asOf };
      } },
    });

    assert.equal(worker.start(), false);
    assert.equal(clock.scheduled.length, 0);
    assert.equal(worker.start({
      enabled: true, intervalMs: 3_600_000, batchSize: 250, isLiveReady: () => true,
    }), true);
    await clock.scheduled[0].callback();

    assert.deepEqual(calls, [{ asOf: '2026-08-10T12:00:00.000Z', limit: 250 }]);
    assert.equal(clock.scheduled[1].delayMs, 3_600_000);
    assert.equal(worker.getStatus().totalSaved, 3);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('is single-flight and backs off transient database failures', async () => {
    const clock = scheduler();
    let resolveFirst;
    let calls = 0;
    const worker = createRobinhoodHolderSnapshotWorker({
      ...clock, now: () => NOW, logger: { warn() {} },
      repository: { syncLiveDailySnapshots: async () => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        if (calls === 2) throw new Error('temporary database failure');
        return { savedCount: 0, asOf: new Date(NOW).toISOString() };
      } },
    });

    const first = worker.runOnce();
    const duplicate = worker.runOnce();
    resolveFirst({ savedCount: 1, asOf: new Date(NOW).toISOString() });
    await Promise.all([first, duplicate]);
    assert.equal(calls, 1);
    worker.start({
      enabled: true, intervalMs: 3_600_000, maxErrorBackoffMs: 100_000,
      isLiveReady: () => true,
    });
    await clock.scheduled[0].callback();

    assert.equal(clock.scheduled[1].delayMs, 100_000);
    assert.equal(worker.getStatus().totalErrors, 1);
    await clock.scheduled[1].callback();
    assert.equal(clock.scheduled[2].delayMs, 3_600_000);
    await worker.stop();
  });

  it('waits without writing while live capture is unhealthy', async () => {
    let writes = 0;
    const worker = createRobinhoodHolderSnapshotWorker({
      repository: { syncLiveDailySnapshots: async () => { writes += 1; } },
    });
    worker.start({ enabled: true, isLiveReady: () => false });

    assert.deepEqual(await worker.runOnce(), { status: 'waiting-live', savedCount: 0 });
    assert.equal(writes, 0);
    assert.equal(worker.getStatus().totalWaitingLive, 1);
    await worker.stop();
  });
});
