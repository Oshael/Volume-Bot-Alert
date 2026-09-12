const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DEFAULT_FALLBACK_INTERVAL_MS,
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
    holderCountUpdates: 1, holderCountPublished: 1,
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
        runner: { captureOnce: async (input) => { calls.push(input); return completed(); } },
      }),
    });

    assert.equal(worker.start(), false);
    assert.equal(clock.scheduled.length, 0);
    assert.throws(
      () => worker.start({ enabled: true }),
      (error) => error.code === 'configuration_error'
    );
    assert.throws(
      () => worker.start({
        enabled: true, admittedAfter: '2026-08-10T00:00:00Z', sourceMode: 'unknown',
      }),
      (error) => error.code === 'configuration_error'
    );
    assert.equal(worker.start({
      enabled: true, intervalMs: 750, admittedAfter: '2026-08-10T00:00:00Z',
    }), true);
    assert.equal(clock.scheduled[0].delayMs, 0);
    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 750);
    assert.equal(calls[0].rangeSize, 250);
    assert.equal(calls[0].addressShardConcurrency, 2);
    assert.equal(calls[0].confirmations, 12);
    assert.deepEqual(worker.getStatus().lastResult, {
      status: 'completed', captureStatus: 'captured', nextBlock: '106', safeHead: '105',
      handoffStatus: 'shadow', handoffPromotions: 1, handoffResyncs: 0,
      capturedTransfers: 3, seededTokens: 0, bufferedSeededTokens: 0,
      appliedEvents: 2, driftedTokens: 1,
      driftSuspicions: 0, receiptRecoveries: 0, driftDeferred: 0,
      tailRollbacks: 0, tailRollbackEvents: 0,
      quarantinedTokenAddress: null, quarantinedTokens: 0,
      holderCountUpdates: 1, holderCountPublished: 1,
      applyBudgetExhausted: false,
    });
    assert.equal(worker.getStatus().totalAppliedEvents, 2);
    assert.equal(worker.getStatus().totalHolderCountPublished, 1);
    assert.equal(worker.getStatus().totalHandoffPromotions, 1);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('wakes canonical capture after commit and keeps polling as a bounded fallback', async () => {
    const clock = scheduler();
    const calls = [];
    const listenerCalls = [];
    let notify;
    let connected;
    const worker = createRobinhoodHolderLiveWorker({
      ...clock,
      listenerFactory: (input) => {
        notify = input.onNotification;
        connected = input.onConnected;
        return {
          start: async () => listenerCalls.push(['start', input.channel]),
          stop: async () => listenerCalls.push(['stop']),
          getStatus: () => ({ running: true, listening: true }),
        };
      },
      runtimeFactory: async () => ({
        sourceMode: 'canonical_journal', providerName: 'canonical_journal',
        runner: { captureOnce: async (input) => {
          calls.push(input);
          return completed({ captureStatus: 'idle' });
        } },
      }),
    });

    assert.equal(DEFAULT_FALLBACK_INTERVAL_MS, 5000);
    worker.start({
      enabled: true, sourceMode: 'canonical_journal',
      admittedAfter: '2026-08-10T00:00:00Z',
    });
    await clock.scheduled[0].callback();
    assert.deepEqual(listenerCalls[0], ['start', 'robinhood_chain_capture']);
    assert.equal(calls[0].confirmations, 0);
    assert.equal(clock.scheduled.at(-1).delayMs, 5000);
    assert.equal(worker.getStatus().totalFallbackRuns, 0);

    notify();
    assert.equal(clock.scheduled.at(-1).delayMs, 0);
    await clock.scheduled.at(-1).callback();
    assert.equal(calls[1].confirmations, 0);
    assert.equal(worker.getStatus().totalWakeups, 1);
    assert.equal(worker.getStatus().captureListener.listening, true);
    await clock.scheduled.at(-1).callback();
    assert.equal(worker.getStatus().totalFallbackRuns, 1);

    connected({ isReconnect: true });
    assert.equal(clock.scheduled.at(-1).delayMs, 0);
    assert.equal(worker.getStatus().totalWakeups, 2);
    await worker.stop();
    assert.deepEqual(listenerCalls.at(-1), ['stop']);
  });

  it('coalesces notifications received while canonical capture is in flight', async () => {
    const clock = scheduler();
    let notify;
    let finish;
    const capture = new Promise((resolve) => { finish = resolve; });
    const worker = createRobinhoodHolderLiveWorker({
      ...clock,
      listenerFactory: (input) => {
        notify = input.onNotification;
        return { start: async () => {}, stop: async () => {} };
      },
      runtimeFactory: async () => ({
        sourceMode: 'canonical_journal', providerName: 'canonical_journal',
        runner: { captureOnce: () => capture },
      }),
    });

    worker.start({
      enabled: true, sourceMode: 'canonical_journal',
      admittedAfter: '2026-08-10T00:00:00Z',
    });
    const active = clock.scheduled[0].callback();
    await Promise.resolve();
    notify();
    notify();
    assert.equal(clock.scheduled.length, 1);
    finish(completed());
    await active;
    assert.equal(clock.scheduled.length, 2);
    assert.equal(clock.scheduled[1].delayMs, 0);
    assert.equal(worker.getStatus().totalWakeups, 2);
    await worker.stop();
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
        runner: { captureOnce: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary RPC failure');
          return completed();
        } },
      }),
    });
    worker.start({
      enabled: true, intervalMs: 500, maxErrorBackoffMs: 5000,
      admittedAfter: '2026-08-10T00:00:00Z',
    });

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
        runner: { captureOnce: async () => ({
          status: 'blocked', reason: 'canonical-evidence-unavailable',
        }) },
      }),
    });
    worker.start({
      enabled: true, admittedAfter: '2026-08-10T00:00:00Z',
      onFatal: async (error) => fatals.push(error),
    });

    await clock.scheduled[0].callback();

    assert.equal(worker.getStatus().halted, true);
    assert.equal(worker.getStatus().running, false);
    assert.equal(worker.getStatus().lastError.code, 'holder_reorg_unrecoverable');
    assert.equal(fatals[0].fatal, true);
    assert.equal(clock.scheduled.length, 1);
  });

  it('builds every dependency on the sole configured holder RPC', async () => {
    const calls = [];
    let disabledPublisher;
    const rpcClient = { request() {} };
    const ledger = { applyNextPendingEvent() {} };
    const reader = { assertChain: async () => calls.push('chain') };
    const capture = { captureOnce() {} };
    const bootstrap = { seedNewTokens() {} };
    const handoffRepository = { getNextCandidate() {} };
    const handoff = { runOnce() {} };
    const runner = { runOnce() {} };
    const runtime = await buildRuntime({ rpcTimeoutMs: 9000, addressShardConcurrency: 2 }, {
      env: {
        ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
        ROBINHOOD_DRPC_RPC_URL: 'https://drpc.invalid',
      },
      rpcClientFactory: (input) => {
        calls.push(['rpc', input]);
        return rpcClient;
      },
      ledgerFactory: (input) => { calls.push(['ledger', input]); return ledger; },
      bootstrapFactory: (input) => { calls.push(['bootstrap', input]); return bootstrap; },
      readerFactory: (input) => { calls.push(['reader', input]); return reader; },
      captureFactory: (input) => { calls.push(['capture', input]); return capture; },
      handoffRepositoryFactory: (input) => {
        calls.push(['handoffRepository', input]);
        return handoffRepository;
      },
      handoffFactory: (input) => { calls.push(['handoff', input]); return handoff; },
      runnerFactory: (input) => {
        disabledPublisher = input.publishHolderCounts;
        calls.push(['runner', {
          capture: input.capture, handoff: input.handoff, ledger: input.ledger,
          reader: input.reader,
        }]);
        return runner;
      },
      database: 'database',
    });

    assert.equal(runtime.providerName, 'robinhood-holder-live');
    assert.equal(runtime.sourceMode, 'rpc');
    assert.equal(runtime.runner, runner);
    assert.equal(await disabledPublisher([]), 0);
    assert.deepEqual(calls, [
      ['rpc', {
        providers: [{ name: 'robinhood-holder-live', url: 'http://127.0.0.1:8547' }],
        timeoutMs: 9000, maxRetries: 1,
      }],
      ['reader', { rpcClient, addressShardConcurrency: 2 }], 'chain',
      ['ledger', { database: 'database' }],
      ['bootstrap', { database: 'database' }],
      ['capture', { bootstrap, ledger, reader }],
      ['handoffRepository', { database: 'database' }],
      ['handoff', { repository: handoffRepository, reader }],
      ['runner', { capture, handoff, ledger, reader }],
    ]);
  });

  it('wires capture and handoff to the canonical journal without creating an RPC client', async () => {
    const calls = [];
    let disabledPublisher;
    const reader = { assertChain: async () => calls.push('chain') };
    const runtime = await buildRuntime({
      sourceMode: 'canonical_journal', rpcTimeoutMs: 9000, addressShardConcurrency: 2,
    }, {
      database: 'database',
      rpcClientFactory: () => { throw new Error('RPC must not be created'); },
      canonicalReaderFactory: (input) => { calls.push(['canonical', input]); return reader; },
      ledger: 'ledger', bootstrap: 'bootstrap', handoffRepository: 'handoffRepository',
      captureFactory: (input) => { calls.push(['capture', input]); return 'capture'; },
      handoffFactory: (input) => { calls.push(['handoff', input]); return 'handoff'; },
      runnerFactory: (input) => {
        disabledPublisher = input.publishHolderCounts;
        calls.push(['runner', {
          capture: input.capture, handoff: input.handoff, ledger: input.ledger,
          reader: input.reader,
        }]);
        return 'runner';
      },
    });

    assert.equal(runtime.sourceMode, 'canonical_journal');
    assert.equal(runtime.providerName, 'canonical_journal');
    assert.equal(runtime.runner, 'runner');
    assert.equal(await disabledPublisher([]), 0);
    assert.deepEqual(calls, [
      ['canonical', { database: 'database' }], 'chain',
      ['capture', { bootstrap: 'bootstrap', ledger: 'ledger', reader }],
      ['handoff', { repository: 'handoffRepository', reader }],
      ['runner', {
        capture: 'capture', handoff: 'handoff', ledger: 'ledger', reader,
      }],
    ]);
  });
});
