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
    const worker = createRobinhoodHolderLiveApplyWorker({
      ...clock,
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
            shadowPromotions: 3,
            holderCountUpdates: 2, holderCountPublished: 2,
            applyBudgetExhausted: true,
          };
        } },
      }),
    });

    assert.equal(worker.start({
      enabled: true, intervalMs: 75, maxApplyEvents: 25, applyBatchSize: 20,
    }), true);
    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 75);
    assert.equal(calls[0].maxApplyEvents, 25);
    assert.equal(calls[0].applyBatchSize, 20);
    assert.equal(worker.getStatus().totalAppliedEvents, 25);
    assert.equal(worker.getStatus().totalShadowPromotions, 3);
    assert.equal(worker.getStatus().totalBaselineRequeues, 2);
    assert.equal(worker.getStatus().lastResult.applyBudgetExhausted, true);
    await worker.stop();
  });

  it('builds only the apply dependencies on the configured holder RPC', async () => {
    const calls = [];
    const rpcClient = { request() {} };
    const ledger = { applyNextPendingEvent() {} };
    const reader = { assertChain: async () => calls.push('chain') };
    const runner = { applyOnce() {} };
    const publishHolderCounts = async () => 0;
    const runtime = await buildRuntime({ rpcTimeoutMs: 9000 }, {
      env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      rpcClientFactory: (input) => { calls.push(['rpc', input]); return rpcClient; },
      ledgerFactory: (input) => { calls.push(['ledger', input]); return ledger; },
      readerFactory: (input) => { calls.push(['reader', input]); return reader; },
      runnerFactory: (input) => { calls.push(['runner', input]); return runner; },
      publishHolderCounts, database: 'database',
    });

    assert.equal(runtime.providerName, 'robinhood-holder-live-apply');
    assert.equal(runtime.runner, runner);
    assert.deepEqual(calls, [
      ['rpc', {
        providers: [{ name: 'robinhood-holder-live-apply', url: 'http://127.0.0.1:8547' }],
        timeoutMs: 9000, maxRetries: 1,
      }],
      ['ledger', { database: 'database' }],
      ['reader', { rpcClient }], 'chain',
      ['runner', { ledger, reader, publishHolderCounts }],
    ]);
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
