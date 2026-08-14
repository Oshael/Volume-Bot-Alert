const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderBackfillWorker,
} = require('../src/services/robinhood-holder-backfill-worker');

const TOKEN = `0x${'1'.repeat(40)}`;
const CUTOFF = '2026-08-10T00:00:00.000Z';

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

function committed() {
  return {
    status: 'committed', tokenAddress: TOKEN, atBarrier: true, safeHead: '105',
  };
}

describe('Robinhood holder backfill worker', () => {
  it('stays opt-in and admits before replaying one bounded range per tick', async () => {
    const clock = scheduler();
    const calls = [];
    const bootstrap = {
      seedNewTokens: async (input) => {
        calls.push(['seed', input]);
        return [{ tokenAddress: TOKEN }];
      },
    };
    const executor = {
      runOnce: async (input) => { calls.push(['replay', input]); return committed(); },
    };
    const worker = createRobinhoodHolderBackfillWorker({
      ...clock, database: 'database', env: { ROBINHOOD_RPC_URL: 'http://node' },
      bootstrapFactory: (input) => { calls.push(['bootstrap', input]); return bootstrap; },
      executorFactory: (input) => { calls.push(['executor', input]); return executor; },
    });

    assert.equal(worker.start(), false);
    assert.equal(clock.scheduled.length, 0);
    assert.equal(worker.start({
      enabled: true, admittedAfter: CUTOFF, intervalMs: 750,
      seedLimit: 25, rangeSize: 100, confirmations: 20,
    }), true);
    await clock.scheduled[0].callback();

    assert.deepEqual(calls, [
      ['bootstrap', { database: 'database' }],
      ['executor', {
        database: 'database', env: { ROBINHOOD_RPC_URL: 'http://node' },
      }],
      ['seed', { admittedAfter: CUTOFF, limit: 25, maxInitialGapBlocks: 20_000 }],
      ['replay', {
        rangeSize: 100, confirmations: 20, shardCount: 1, shardIndex: 0,
      }],
    ]);
    assert.equal(clock.scheduled[1].delayMs, 750);
    assert.deepEqual(worker.getStatus().lastResult, {
      status: 'completed', seededTokens: 1, replayStatus: 'committed',
      tokenAddress: TOKEN, committedRanges: 1, driftSuspicions: 0, driftedTokens: 0,
      resyncingTokens: 0, activeExecutors: 1, atBarrier: true, safeHead: '105',
    });
    assert.equal(worker.getStatus().concurrency, 1);
    assert.equal(worker.getStatus().totalSeededTokens, 1);
    assert.equal(worker.getStatus().totalCommittedRanges, 1);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('runs disjoint token shards concurrently and aggregates their commits', async () => {
    const clock = scheduler();
    const replayInputs = [];
    const worker = createRobinhoodHolderBackfillWorker({
      ...clock,
      runtimeFactory: () => ({
        bootstrap: { seedNewTokens: async () => [] },
        executor: {
          runOnce: async (input) => {
            replayInputs.push(input);
            return committed();
          },
        },
      }),
    });
    worker.start({ enabled: true, admittedAfter: CUTOFF, concurrency: 4 });

    await clock.scheduled[0].callback();

    assert.deepEqual(replayInputs.map(({ shardCount, shardIndex }) => (
      [shardCount, shardIndex]
    )), [[4, 0], [4, 1], [4, 2], [4, 3]]);
    assert.equal(worker.getStatus().concurrency, 4);
    assert.equal(worker.getStatus().lastResult.activeExecutors, 4);
    assert.equal(worker.getStatus().lastResult.committedRanges, 4);
    assert.equal(worker.getStatus().totalCommittedRanges, 4);
    await worker.stop();
  });

  it('waits for every shard before backing off a failed tick', async () => {
    const clock = scheduler();
    let finishSlowShard;
    const slowShard = new Promise((resolve) => { finishSlowShard = resolve; });
    const worker = createRobinhoodHolderBackfillWorker({
      ...clock, logger: { warn() {}, error() {} },
      runtimeFactory: () => ({
        bootstrap: { seedNewTokens: async () => [] },
        executor: {
          runOnce: ({ shardIndex }) => shardIndex === 0
            ? Promise.reject(new Error('temporary shard failure')) : slowShard,
        },
      }),
    });
    worker.start({
      enabled: true, admittedAfter: CUTOFF, concurrency: 2,
      intervalMs: 500, maxErrorBackoffMs: 5000,
    });

    const tick = clock.scheduled[0].callback();
    await Promise.resolve();
    assert.equal(clock.scheduled.length, 1);
    finishSlowShard({ status: 'idle', safeHead: '105' });
    await tick;

    assert.equal(clock.scheduled[1].delayMs, 1000);
    await worker.stop();
  });

  it('requires a durable admission cutoff before enabling', () => {
    const worker = createRobinhoodHolderBackfillWorker();
    for (const admittedAfter of [undefined, null, 'not-a-date']) {
      assert.throws(
        () => worker.start({ enabled: true, admittedAfter }),
        (error) => error.code === 'configuration_error'
      );
    }
  });

  it('backs off transient failures without losing the fixed cutoff', async () => {
    const clock = scheduler();
    const seedInputs = [];
    let attempts = 0;
    const worker = createRobinhoodHolderBackfillWorker({
      ...clock, logger: { warn() {}, error() {} },
      runtimeFactory: () => ({
        bootstrap: { seedNewTokens: async (input) => { seedInputs.push(input); return []; } },
        executor: { runOnce: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary RPC failure');
          return { status: 'idle', safeHead: '105' };
        } },
      }),
    });
    worker.start({
      enabled: true, admittedAfter: CUTOFF, intervalMs: 500, maxErrorBackoffMs: 5000,
    });

    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 1000);
    await clock.scheduled[1].callback();
    assert.equal(clock.scheduled[2].delayMs, 500);
    assert.deepEqual(seedInputs.map(({ admittedAfter }) => admittedAfter), [CUTOFF, CUTOFF]);
    await worker.stop();
  });

  it('keeps an unverified drift in cooldown without halting the worker', async () => {
    const clock = scheduler();
    const worker = createRobinhoodHolderBackfillWorker({
      ...clock,
      runtimeFactory: () => ({
        bootstrap: { seedNewTokens: async () => [] },
        executor: { runOnce: async () => ({
          status: 'drift-unverified', tokenAddress: TOKEN,
          reason: 'holder_receipt_range_too_wide', safeHead: '105',
        }) },
      }),
    });
    worker.start({ enabled: true, admittedAfter: CUTOFF, intervalMs: 500 });

    await clock.scheduled[0].callback();

    const status = worker.getStatus();
    assert.equal(status.halted, false);
    assert.equal(status.lastError, null);
    assert.equal(status.lastResult.replayStatus, 'drift-unverified');
    assert.equal(status.lastResult.reason, 'holder_receipt_range_too_wide');
    assert.equal(clock.scheduled[1].delayMs, 500);
    await worker.stop();
  });

  it('halts and propagates an invalid executor contract', async () => {
    const clock = scheduler();
    const fatals = [];
    const worker = createRobinhoodHolderBackfillWorker({
      ...clock,
      runtimeFactory: () => ({
        bootstrap: { seedNewTokens: async () => [] },
        executor: { runOnce: async () => ({ status: 'mystery' }) },
      }),
    });
    worker.start({ enabled: true, admittedAfter: CUTOFF, onFatal: (error) => fatals.push(error) });

    await clock.scheduled[0].callback();

    assert.equal(worker.getStatus().halted, true);
    assert.equal(worker.getStatus().lastError.code, 'holder_backfill_contract_error');
    assert.equal(fatals[0].code, 'holder_backfill_contract_error');
    assert.equal(clock.scheduled.length, 1);
  });
});
