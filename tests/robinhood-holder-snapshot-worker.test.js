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
  it('drains temporal continuity in ordered transaction-sized pages', async () => {
    const clock = scheduler();
    const calls = [];
    const pauses = [];
    const audits = [];
    const elapsed = [100, 140, 200, 225];
    const cursor = `0x${'1'.repeat(40)}`;
    const worker = createRobinhoodHolderSnapshotWorker({
      ...clock, now: () => NOW, clock: () => elapsed.shift(),
      wait: async (delayMs) => { pauses.push(delayMs); },
      repository: {
        materializeLiveTemporalSnapshots: async (input) => {
          calls.push(input);
          return calls.length === 1
            ? { savedCount: 2, dailyCount: 1, scannedCount: 2,
              nextToken: cursor, complete: false, asOf: input.asOf }
            : { savedCount: 1, dailyCount: 0, scannedCount: 1,
              nextToken: `0x${'2'.repeat(40)}`, complete: true, asOf: input.asOf };
        },
        auditLiveTemporalSnapshots: async (input) => {
          audits.push(input);
          return { eligibleCount: 3, missingDaily: 0, missingHourly: 0, safe: true };
        },
      },
    });

    worker.start({
      enabled: true, batchSize: 250, pagePauseMs: 25,
      statementTimeoutMs: 15_000, isLiveReady: () => true,
    });
    await clock.scheduled[0].callback();

    assert.deepEqual(calls, [{
      asOf: '2026-08-10T12:00:00.000Z', limit: 250, afterToken: null,
      statementTimeoutMs: 15_000,
    }, {
      asOf: '2026-08-10T12:00:00.000Z', limit: 250, afterToken: cursor,
      statementTimeoutMs: 15_000,
    }]);
    assert.deepEqual(pauses, [25]);
    assert.deepEqual(audits, [{
      asOf: '2026-08-10T12:00:00.000Z', statementTimeoutMs: 15_000,
    }]);
    assert.equal(worker.getStatus().totalSaved, 3);
    assert.deepEqual(worker.getStatus().lastResult, {
      savedCount: 3, dailyCount: 1, scannedCount: 3,
      pages: 2, complete: true, asOf: '2026-08-10T12:00:00.000Z',
      pagePauseMs: 25, lastPageMs: 25, maxPageMs: 40,
      audit: { eligibleCount: 3, missingDaily: 0, missingHourly: 0, safe: true },
    });
    await worker.stop();
  });

  it('rejects a completed pass when the point-in-time parity audit finds a gap', async () => {
    const clock = scheduler();
    const worker = createRobinhoodHolderSnapshotWorker({
      ...clock, now: () => NOW, logger: { warn() {} },
      repository: {
        materializeLiveTemporalSnapshots: async () => ({
          savedCount: 1, dailyCount: 1, scannedCount: 1,
          nextToken: `0x${'1'.repeat(40)}`, complete: true,
        }),
        auditLiveTemporalSnapshots: async () => ({
          eligibleCount: 1, missingDaily: 0, missingHourly: 1, safe: false,
        }),
      },
    });

    await worker.runOnce();

    assert.equal(worker.getStatus().lastResult, null);
    assert.equal(worker.getStatus().lastError.code, 'holder_snapshot_parity_failed');
    assert.equal(worker.getStatus().totalErrors, 1);
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

  it('retries readiness promptly without writing while live capture starts', async () => {
    const clock = scheduler();
    let writes = 0;
    let liveReady = false;
    const worker = createRobinhoodHolderSnapshotWorker({
      ...clock,
      repository: { syncLiveDailySnapshots: async () => {
        writes += 1;
        return { savedCount: 1 };
      } },
    });
    worker.start({ enabled: true, isLiveReady: () => liveReady });

    await clock.scheduled[0].callback();
    assert.equal(writes, 0);
    assert.equal(worker.getStatus().totalWaitingLive, 1);
    assert.equal(clock.scheduled[1].delayMs, 10_000);

    liveReady = true;
    await clock.scheduled[1].callback();
    assert.equal(writes, 1);
    assert.equal(clock.scheduled[2].delayMs, 3_600_000);
    await worker.stop();
  });
});
