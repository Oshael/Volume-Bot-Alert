const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderLiveApplyWorker,
  __private: { buildRuntime },
} = require('../src/services/robinhood-holder-live-apply-worker');

function scheduler() {
  const scheduled = [];
  return {
    scheduled,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule() {},
  };
}

describe('Robinhood holder live apply worker', () => {
  it('drains independently on its own bounded schedule', async () => {
    const clock = scheduler();
    const calls = [];
    const listenerCalls = [];
    const worker = createRobinhoodHolderLiveApplyWorker({
      ...clock,
      listenerFactory: (input) => ({
        start: async () => listenerCalls.push(['start', input.channel]),
        stop: async () => listenerCalls.push(['stop']),
      }),
      env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      runtimeFactory: async () => ({
        providerName: 'robinhood-holder-live-apply',
        runner: { applyOnce: async (input) => {
          calls.push(input);
          return {
            status: 'completed', appliedEvents: 25, applyAttempts: 25,
            driftedTokens: 0, driftSuspicions: 0, receiptRecoveries: 0,
            tailRollbacks: 0, tailRollbackEvents: 0,
            baselineRequeues: 2,
            quarantinedTokens: 1,
            shadowPromotions: 3,
            holderCountUpdates: 2, holderCountPublished: 2,
            applyBudgetExhausted: true,
          };
        } },
      }),
    });

    assert.equal(worker.start({
      enabled: true, intervalMs: 75, concurrency: 4,
      maxApplyEvents: 25, applyBatchSize: 20,
      shadowPromotionBatchSize: 15, hotApplyBatchSize: 10, maxDurationMs: 1500,
    }), true);
    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 75);
    assert.equal(calls[0].concurrency, 4);
    assert.equal(calls[0].maxApplyEvents, 25);
    assert.equal(calls[0].shadowPromotionBatchSize, 15);
    assert.equal(calls[0].applyBatchSize, 20);
    assert.equal(calls[0].hotApplyBatchSize, 10);
    assert.equal(calls[0].maxDurationMs, 1500);
    assert.deepEqual(listenerCalls[0], ['start', 'robinhood_holder_hot_queue']);
    assert.deepEqual(listenerCalls[1], ['start', 'robinhood_holder_realtime_outbox']);
    assert.equal(worker.getStatus().totalAppliedEvents, 25);
    assert.equal(worker.getStatus().totalShadowPromotions, 3);
    assert.equal(worker.getStatus().totalBaselineRequeues, 2);
    assert.equal(worker.getStatus().totalQuarantinedTokens, 1);
    assert.equal(worker.getStatus().lastResult.applyBudgetExhausted, true);
    await worker.stop();
    assert.equal(listenerCalls.filter(([event]) => event === 'stop').length, 2);
  });

  it('wakes the apply loop immediately when a hot token is committed', async () => {
    const clock = scheduler();
    let notify;
    const worker = createRobinhoodHolderLiveApplyWorker({
      ...clock,
      listenerFactory: (input) => {
        notify = input.onNotification;
        return { start: async () => {}, stop: async () => {} };
      },
      runtimeFactory: async () => ({
        providerName: 'robinhood-holder-live-apply',
        runner: { applyOnce: async () => ({ status: 'completed' }) },
      }),
    });

    worker.start({ enabled: true, intervalMs: 100 });
    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled.at(-1).delayMs, 100);
    notify();
    assert.equal(clock.scheduled.at(-1).delayMs, 0);
    assert.equal(worker.getStatus().totalWakeups, 1);
    await worker.stop();
  });

  it('builds only the apply dependencies on the configured holder RPC', async () => {
    const calls = [];
    let disabledPublisher;
    const rpcClient = { request() {} };
    const ledger = { applyNextPendingEvent() {} };
    const reader = { assertChain: async () => calls.push('chain') };
    const runner = { applyOnce() {} };
    const runtime = await buildRuntime({ rpcTimeoutMs: 9000 }, {
      env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      rpcClientFactory: (input) => { calls.push(['rpc', input]); return rpcClient; },
      ledgerFactory: (input) => { calls.push(['ledger', input]); return ledger; },
      readerFactory: (input) => { calls.push(['reader', input]); return reader; },
      runnerFactory: (input) => {
        disabledPublisher = input.publishHolderCounts;
        calls.push(['runner', { ledger: input.ledger, reader: input.reader }]);
        return runner;
      },
      publisher: 'publisher', realtimeOutbox: 'outbox', database: 'database',
    });

    assert.equal(runtime.providerName, 'robinhood-holder-live-apply');
    assert.equal(runtime.sourceMode, 'rpc');
    assert.equal(runtime.runner, runner);
    assert.equal(runtime.publisher, 'publisher');
    assert.equal(runtime.realtimeOutbox, 'outbox');
    assert.equal(await disabledPublisher([]), 0);
    assert.deepEqual(calls, [
      ['rpc', {
        providers: [{ name: 'robinhood-holder-live-apply', url: 'http://127.0.0.1:8547' }],
        timeoutMs: 9000, maxRetries: 1,
      }],
      ['reader', { rpcClient }], 'chain',
      ['ledger', { database: 'database' }],
      ['runner', { ledger, reader }],
    ]);
  });

  it('uses the canonical journal for drift repair without creating an RPC client', async () => {
    const calls = [];
    let disabledPublisher;
    const reader = { assertChain: async () => calls.push('chain') };
    const runtime = await buildRuntime({
      sourceMode: 'canonical_journal', rpcTimeoutMs: 9000,
    }, {
      database: 'database', ledger: 'ledger',
      rpcClientFactory: () => { throw new Error('RPC must not be created'); },
      canonicalReaderFactory: (input) => { calls.push(['canonical', input]); return reader; },
      runnerFactory: (input) => {
        disabledPublisher = input.publishHolderCounts;
        calls.push(['runner', { ledger: input.ledger, reader: input.reader }]);
        return 'runner';
      },
      publisher: 'publisher', realtimeOutbox: 'outbox',
    });

    assert.equal(runtime.sourceMode, 'canonical_journal');
    assert.equal(runtime.providerName, 'canonical_journal');
    assert.equal(runtime.runner, 'runner');
    assert.equal(await disabledPublisher([]), 0);
    assert.deepEqual(calls, [
      ['canonical', { database: 'database' }], 'chain',
      ['runner', { ledger: 'ledger', reader }],
    ]);
  });

  it('drains lifecycle and publication durably without requiring a notification', async () => {
    let publications = 0;
    const backlog = {
      pending: 0, due: 0, leased: 0, expiredLeases: 0,
      blocked: 0, maxAttempts: 1, oldestAgeSeconds: null,
    };
    const worker = createRobinhoodHolderLiveApplyWorker({
      runtimeFactory: async () => ({
        providerName: 'robinhood-holder-live-apply',
        runner: { applyOnce: async () => ({
          status: 'completed', appliedEvents: 1, holderCountUpdates: 1,
          holderCountPublished: 0,
        }) },
        realtimeOutbox: {
          promoteFinalized: async () => ({ finalized: 1, invalidated: 1 }),
          readBacklog: async () => backlog,
        },
        publisher: { runOnce: async () => {
          publications += 1;
          return { reclaimed: 0, claimed: 2, delivered: 2, retried: 0, blocked: 0 };
        } },
      }),
    });

    const first = await worker.runOnce();
    const second = await worker.runOnce();

    assert.equal(publications, 2);
    assert.deepEqual(first.realtime, {
      lifecycle: { finalized: 1, invalidated: 1 },
      publication: { reclaimed: 0, claimed: 2, delivered: 2, retried: 0, blocked: 0 },
      backlog,
    });
    assert.equal(second.realtime.backlog.pending, 0);
    assert.equal(worker.getStatus().totalHolderCountPublished, 4);
    assert.equal(worker.getStatus().totalFinalized, 2);
    assert.equal(worker.getStatus().totalInvalidated, 2);
  });

  it('retries runtime initialization after a transient failure', async () => {
    let attempts = 0;
    const worker = createRobinhoodHolderLiveApplyWorker({
      logger: { warn() {}, error() {} },
      runtimeFactory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary chain check failure');
        return {
          providerName: 'robinhood-holder-live-apply',
          runner: { applyOnce: async () => ({ status: 'completed' }) },
        };
      },
    });

    assert.equal(await worker.runOnce(), null);
    assert.deepEqual(await worker.runOnce(), { status: 'completed' });
    assert.equal(attempts, 2);
  });

  it('retains holder stage, token, and structured PostgreSQL diagnostics', async () => {
    const tokenAddress = `0x${'a'.repeat(40)}`;
    const failure = Object.assign(new Error('numeric field overflow'), {
      code: '22003', holderStage: 'apply', holderTokenAddress: tokenAddress,
      severity: 'ERROR', detail: 'precision 78 overflow', schema: 'public',
      table: 'robinhood_holder_balances', column: 'balance_raw',
      constraint: 'balance_precision', dataType: 'numeric', routine: 'apply_typmod',
    });
    const worker = createRobinhoodHolderLiveApplyWorker({
      logger: { warn() {}, error() {} },
      runtimeFactory: async () => ({
        providerName: 'robinhood-holder-live-apply',
        runner: { applyOnce: async () => { throw failure; } },
      }),
    });

    assert.equal(await worker.runOnce(), null);
    assert.deepEqual(worker.getStatus().lastError, {
      code: '22003', message: 'numeric field overflow',
      at: worker.getStatus().lastError.at,
      stage: 'apply', tokenAddress,
      postgres: {
        severity: 'ERROR', detail: 'precision 78 overflow', schema: 'public',
        table: 'robinhood_holder_balances', column: 'balance_raw',
        constraint: 'balance_precision', dataType: 'numeric', routine: 'apply_typmod',
      },
    });
  });
});
