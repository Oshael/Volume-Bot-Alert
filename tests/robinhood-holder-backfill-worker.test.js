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
      ['seed', { admittedAfter: CUTOFF, limit: 25 }],
      ['replay', { rangeSize: 100, confirmations: 20 }],
    ]);
    assert.equal(clock.scheduled[1].delayMs, 750);
    assert.deepEqual(worker.getStatus().lastResult, {
      status: 'completed', seededTokens: 1, replayStatus: 'committed',
      tokenAddress: TOKEN, committedRanges: 1, driftSuspicions: 0, driftedTokens: 0,
      resyncingTokens: 0, atBarrier: true, safeHead: '105',
    });
    assert.equal(worker.getStatus().totalSeededTokens, 1);
    assert.equal(worker.getStatus().totalCommittedRanges, 1);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
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
