const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderColdWorker,
  __private,
} = require('../src/services/robinhood-holder-cold-worker');

const CUTOFF = '2026-08-10T00:00:00.000Z';
const TOKEN = `0x${'a'.repeat(40)}`;
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
function completed() {
  return {
    candidates: 2, verified: 1, failed: 1, providerError: null,
    seededTokens: 1, replayStatus: 'committed', tokenAddress: TOKEN, atBarrier: false,
  };
}

describe('Robinhood holder cold worker', () => {
  it('stays opt-in and schedules bounded single-flight cold ticks', async () => {
    const clock = scheduler();
    const calls = [];
    const worker = createRobinhoodHolderColdWorker({
      ...clock,
      runtimeFactory: (options) => { calls.push(['runtime', options]); return { ready: true }; },
      tick: async (runtime, options) => {
        calls.push(['tick', runtime, options]);
        return completed();
      },
    });

    assert.equal(worker.start(), false);
    assert.equal(clock.scheduled.length, 0);
    assert.equal(worker.start({
      enabled: true, admittedBefore: CUTOFF, intervalMs: 90_000,
      candidateLimit: 5, rangeSize: 100, confirmations: 20,
      requestOptions: { requestsPerSecond: 0.25, maxRetries: 1 },
    }), true);
    await clock.scheduled[0].callback();

    assert.equal(calls[0][0], 'runtime');
    assert.deepEqual(calls[1].slice(0, 2), ['tick', { ready: true }]);
    assert.equal(calls[1][2].admittedBefore, CUTOFF);
    assert.equal(clock.scheduled[1].delayMs, 90_000);
    assert.equal(worker.getStatus().totalVerified, 1);
    assert.equal(worker.getStatus().totalFailed, 1);
    assert.equal(worker.getStatus().totalSeeded, 1);
    assert.equal(worker.getStatus().totalCommittedRanges, 1);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('backs off transient failures and halts on an invalid tick contract', async () => {
    const clock = scheduler();
    const fatals = [];
    let attempts = 0;
    const worker = createRobinhoodHolderColdWorker({
      ...clock, runtimeFactory: () => ({}), logger: { warn() {}, error() {} },
      tick: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary RPC failure');
        throw Object.assign(new Error('invalid contract'), { code: 'holder_cold_contract_error' });
      },
    });
    worker.start({
      enabled: true, admittedBefore: CUTOFF, intervalMs: 10_000,
      maxErrorBackoffMs: 100_000, onFatal: (error) => fatals.push(error),
    });

    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 20_000);
    await clock.scheduled[1].callback();
    assert.equal(worker.getStatus().halted, true);
    assert.equal(fatals[0].code, 'holder_cold_contract_error');
    assert.equal(clock.scheduled.length, 2);
  });

  it('requires durable bounds and only accepts the configured primary RPC', () => {
    const worker = createRobinhoodHolderColdWorker();
    assert.throws(
      () => worker.start({ enabled: true }),
      (error) => error.code === 'configuration_error'
    );
    assert.deepEqual(__private.normalizeRequestOptions({
      requestsPerSecond: 0.5, maxRetries: 1,
    }), { requestsPerSecond: 0.5, concurrency: 1, maxRetries: 1 });
    assert.throws(
      () => __private.normalizeRequestOptions({ requestsPerSecond: 2 }),
      (error) => error.code === 'configuration_error'
    );
    assert.deepEqual(__private.resolveRpcProvider({
      ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
    }), { name: 'robinhood-holder-cold', url: 'http://127.0.0.1:8547' });
    assert.throws(
      () => __private.resolveRpcProvider({ ROBINHOOD_DRPC_RPC_URL: 'https://drpc.invalid' }),
      /ROBINHOOD_RPC_URL is required/
    );
  });

  it('builds isolated adapters that share the configured primary RPC', () => {
    const calls = [];
    const rpcClient = { request() {} };
    const make = (name) => (input) => { calls.push([name, input]); return { name }; };
    const options = __private.normalizeOptions({
      enabled: true, admittedBefore: CUTOFF, blockscoutTimeoutMs: 12_000,
      requestOptions: { requestsPerSecond: 0.25, maxRetries: 1 },
    });
    const runtime = __private.buildRuntime({
      env: { ROBINHOOD_BLOCKSCOUT_API_KEY: 'proapi_test' },
      database: 'database', rpcClient,
      repositoryFactory: make('repository'), bootstrapFactory: make('bootstrap'),
      executorFactory: make('executor'), blockscoutFactory: make('blockscout'),
      schedulerFactory: make('scheduler'), verifierFactory: make('verifier'),
    }, options);

    assert.deepEqual(Object.keys(runtime).sort(), [
      'blockscoutClient', 'bootstrap', 'executor', 'repository', 'requestScheduler', 'verifier',
    ]);
    assert.deepEqual(calls.find(([name]) => name === 'executor')[1], {
      database: 'database', env: { ROBINHOOD_BLOCKSCOUT_API_KEY: 'proapi_test' }, rpcClient,
    });
    assert.deepEqual(calls.find(([name]) => name === 'verifier')[1], { rpcClient });
    const blockscout = calls.find(([name]) => name === 'blockscout')[1];
    assert.equal(blockscout.timeoutMs, 12_000);
    assert.equal(blockscout.apiKey, 'proapi_test');
    assert.match(blockscout.apiUrl, /chain_id=4663/);
    assert.deepEqual(calls.find(([name]) => name === 'scheduler')[1], {
      requestsPerSecond: 0.25, concurrency: 1, maxRetries: 1,
    });
  });
});
