const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderLiveWorker,
  __private: { buildRuntime },
} = require('../src/services/robinhood-holder-live-worker');

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

function completed(overrides = {}) {
  return {
    status: 'completed', captureStatus: 'captured', nextBlock: '106', safeHead: '105',
    handoffStatus: 'shadow', handoffPromotions: 1, handoffResyncs: 0,
    capturedTransfers: 3, appliedEvents: 2, driftedTokens: 1,
    applyBudgetExhausted: false, ...overrides,
  };
}

describe('Robinhood holder live worker', () => {
  it('stays disabled by default and schedules bounded ticks only when enabled', async () => {
    const clock = scheduler();
    const calls = [];
    const worker = createRobinhoodHolderLiveWorker({
      ...clock,
      env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      runtimeFactory: async () => ({
        providerName: 'robinhood-holder-live',
        runner: { runOnce: async (input) => { calls.push(input); return completed(); } },
      }),
    });

    assert.equal(worker.start(), false);
    assert.equal(clock.scheduled.length, 0);
    assert.equal(worker.start({ enabled: true, intervalMs: 750 }), true);
    assert.equal(clock.scheduled[0].delayMs, 0);
    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 750);
    assert.equal(calls[0].rangeSize, 250);
    assert.equal(calls[0].maxApplyEvents, 5000);
    assert.deepEqual(worker.getStatus().lastResult, {
      status: 'completed', captureStatus: 'captured', nextBlock: '106', safeHead: '105',
      handoffStatus: 'shadow', handoffPromotions: 1, handoffResyncs: 0,
      capturedTransfers: 3, appliedEvents: 2, driftedTokens: 1,
      applyBudgetExhausted: false,
    });
    assert.equal(worker.getStatus().totalAppliedEvents, 2);
    assert.equal(worker.getStatus().totalHandoffPromotions, 1);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('backs off transient failures and resets after recovery', async () => {
    const clock = scheduler();
    const warnings = [];
    let attempts = 0;
    const worker = createRobinhoodHolderLiveWorker({
      ...clock,
      env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      logger: { warn: (message) => warnings.push(message), error() {} },
      runtimeFactory: async () => ({
        providerName: 'robinhood-holder-live',
        runner: { runOnce: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary RPC failure');
          return completed();
        } },
      }),
    });
    worker.start({ enabled: true, intervalMs: 500, maxErrorBackoffMs: 5000 });

    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 1000);
    assert.equal(worker.getStatus().consecutiveErrors, 1);
    assert.match(warnings[0], /Tick failed/);
    await clock.scheduled[1].callback();
    assert.equal(clock.scheduled[2].delayMs, 500);
    assert.equal(worker.getStatus().consecutiveErrors, 0);
    await worker.stop();
  });

  it('halts and propagates a reorg that lacks canonical evidence', async () => {
    const clock = scheduler();
    const fatals = [];
    const worker = createRobinhoodHolderLiveWorker({
      ...clock,
      env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      runtimeFactory: async () => ({
        providerName: 'robinhood-holder-live',
        runner: { runOnce: async () => ({
          status: 'blocked', reason: 'canonical-evidence-unavailable',
        }) },
      }),
    });
    worker.start({ enabled: true, onFatal: async (error) => fatals.push(error) });

    await clock.scheduled[0].callback();

    assert.equal(worker.getStatus().halted, true);
    assert.equal(worker.getStatus().running, false);
    assert.equal(worker.getStatus().lastError.code, 'holder_reorg_unrecoverable');
    assert.equal(fatals[0].fatal, true);
    assert.equal(clock.scheduled.length, 1);
  });

  it('builds every dependency on the sole configured holder RPC', async () => {
    const calls = [];
    const rpcClient = { request() {} };
    const ledger = { applyNextPendingEvent() {} };
    const reader = { assertChain: async () => calls.push('chain') };
    const capture = { captureOnce() {} };
    const handoffRepository = { getNextCandidate() {} };
    const handoff = { runOnce() {} };
    const runner = { runOnce() {} };
    const runtime = await buildRuntime({ rpcTimeoutMs: 9000 }, {
      env: {
        ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
        ROBINHOOD_DRPC_RPC_URL: 'https://drpc.invalid',
      },
      rpcClientFactory: (input) => {
        calls.push(['rpc', input]);
        return rpcClient;
      },
      ledgerFactory: (input) => { calls.push(['ledger', input]); return ledger; },
      readerFactory: (input) => { calls.push(['reader', input]); return reader; },
      captureFactory: (input) => { calls.push(['capture', input]); return capture; },
      handoffRepositoryFactory: (input) => {
        calls.push(['handoffRepository', input]);
        return handoffRepository;
      },
      handoffFactory: (input) => { calls.push(['handoff', input]); return handoff; },
      runnerFactory: (input) => { calls.push(['runner', input]); return runner; },
      database: 'database',
    });

    assert.equal(runtime.providerName, 'robinhood-holder-live');
    assert.equal(runtime.runner, runner);
    assert.deepEqual(calls, [
      ['rpc', {
        providers: [{ name: 'robinhood-holder-live', url: 'http://127.0.0.1:8547' }],
        timeoutMs: 9000, maxRetries: 1,
      }],
      ['ledger', { database: 'database' }],
      ['reader', { rpcClient }], 'chain',
      ['capture', { ledger, reader }],
      ['handoffRepository', { database: 'database' }],
      ['handoff', { repository: handoffRepository, reader }],
      ['runner', { capture, handoff, ledger }],
    ]);
  });
});
