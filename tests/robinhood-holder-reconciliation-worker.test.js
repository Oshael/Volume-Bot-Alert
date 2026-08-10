const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderReconciliationWorker,
  __private,
} = require('../src/services/robinhood-holder-reconciliation-worker');

const TOKEN = `0x${'a'.repeat(40)}`;

function clock() {
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

describe('Robinhood holder reconciliation worker', () => {
  it('stays opt-in and schedules single-flight reconciliation ticks', async () => {
    const timer = clock();
    const results = [
      { status: 'matching', tokenAddress: TOKEN },
      { status: 'live', tokenAddress: TOKEN },
    ];
    const worker = createRobinhoodHolderReconciliationWorker({
      ...timer,
      runtimeFactory: () => ({ runOnce: async () => results.shift() }),
    });

    assert.equal(worker.start(), false);
    assert.equal(timer.scheduled.length, 0);
    assert.equal(worker.start({
      enabled: true, intervalMs: 30_000, isLiveReady: () => true,
    }), true);
    await timer.scheduled[0].callback();
    await timer.scheduled[1].callback();
    assert.equal(worker.getStatus().totalRuns, 2);
    assert.equal(worker.getStatus().totalPromoted, 1);
    assert.equal(timer.scheduled[2].delayMs, 30_000);
    await worker.stop();
    assert.equal(timer.cancelled.length, 1);
  });

  it('persists successful samples while composing isolated adapters', async () => {
    const calls = [];
    const make = (name, value) => (input) => { calls.push([name, input]); return value; };
    const client = {
      getTokenHolderSummary: async (tokenAddress) => ({
        address: tokenAddress, available: true, holderCount: 42,
        observedAt: '2026-08-10T12:00:00.000Z', source: 'blockscout',
      }),
    };
    const summaryRepository = {
      recordSuccess: async (input) => { calls.push(['summary', input]); },
    };
    let observer;
    let promotionRuns = 0;
    let auditRuns = 0;
    const options = __private.normalizeOptions({ enabled: true });
    const runtime = __private.buildRuntime({
      database: 'database',
      repositoryFactory: make('repository', { repository: true }),
      summaryRepositoryFactory: make('summaryRepository', summaryRepository),
      clientFactory: make('client', client),
      schedulerFactory: make('scheduler', { schedule: (task) => task() }),
      reconcilerFactory: (input) => {
        observer = input.observeHolderCount;
        return { runOnce: async () => { promotionRuns += 1; return { status: 'matching' }; } };
      },
      auditFactory: () => ({
        runOnce: async () => { auditRuns += 1; return { status: 'idle' }; },
      }),
    }, options);

    assert.equal(typeof runtime.runOnce, 'function');
    assert.equal((await observer(TOKEN)).holderCount, 42);
    assert.deepEqual(calls.find(([name]) => name === 'summary')[1], {
      tokenAddress: TOKEN, holderCount: 42, observedAt: '2026-08-10T12:00:00.000Z',
    });
    assert.deepEqual(calls.find(([name]) => name === 'scheduler')[1], {
      requestsPerSecond: 0.25, concurrency: 1, maxRetries: 1,
    });
    assert.equal((await runtime.runOnce()).status, 'matching');
    assert.equal(auditRuns, 1);
    assert.equal(promotionRuns, 1);
  });

  it('backs off transient failures and halts on invalid runtime contracts', async () => {
    const timer = clock();
    const fatals = [];
    let attempts = 0;
    const worker = createRobinhoodHolderReconciliationWorker({
      ...timer, logger: { warn() {}, error() {} },
      runtimeFactory: () => ({
        runOnce: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary provider failure');
          throw new TypeError('invalid reconciler contract');
        },
      }),
    });
    worker.start({
      enabled: true, intervalMs: 10_000, maxErrorBackoffMs: 100_000,
      isLiveReady: () => true,
      onFatal: (error) => fatals.push(error),
    });

    await timer.scheduled[0].callback();
    assert.equal(timer.scheduled[1].delayMs, 20_000);
    await timer.scheduled[1].callback();
    assert.equal(worker.getStatus().halted, true);
    assert.equal(fatals.length, 1);
    assert.equal(timer.scheduled.length, 2);
  });

  it('enforces conservative Blockscout bounds', () => {
    assert.deepEqual(__private.normalizeRequestOptions({}), {
      requestsPerSecond: 0.25, concurrency: 1, maxRetries: 1,
    });
    assert.throws(
      () => __private.normalizeRequestOptions({ requestsPerSecond: 2 }),
      (error) => error.code === 'configuration_error'
    );
    assert.throws(
      () => __private.normalizeOptions({ requiredMatches: 1 }),
      (error) => error.code === 'configuration_error'
    );
    assert.throws(
      () => createRobinhoodHolderReconciliationWorker().start({ enabled: true }),
      (error) => error.code === 'configuration_error'
    );
  });

  it('does not build the runtime before live capture is healthy', async () => {
    const timer = clock();
    let built = false;
    const worker = createRobinhoodHolderReconciliationWorker({
      ...timer, runtimeFactory: () => { built = true; return { runOnce() {} }; },
    });
    worker.start({ enabled: true, isLiveReady: () => false });
    await timer.scheduled[0].callback();
    assert.equal(worker.getStatus().lastResult.status, 'waiting-live');
    assert.equal(worker.getStatus().totalWaitingLive, 1);
    assert.equal(built, false);
    await worker.stop();
  });
});
