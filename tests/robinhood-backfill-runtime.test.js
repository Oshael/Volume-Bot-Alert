const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRobinhoodBackfillAggregationRuntime,
  createRobinhoodBackfillEnrichmentRuntime,
  createRobinhoodBackfillFinalizerRuntime,
  createRobinhoodBackfillWatchdogRuntime,
} = require('../src/services/robinhood-backfill-runtime');

function scheduler() {
  const pending = [];
  const cancelled = [];
  return {
    pending,
    cancelled,
    schedule(callback, delayMs) {
      const handle = { callback, delayMs, unref() {} };
      pending.push(handle);
      return handle;
    },
    cancelSchedule: (handle) => cancelled.push(handle),
  };
}

describe('Robinhood backfill operational runtime', () => {
  it('runs aggregation only when explicitly enabled', async () => {
    const clock = scheduler();
    const calls = [];
    const runtime = createRobinhoodBackfillAggregationRuntime({
      ...clock,
      workerFactory: () => ({
        runOnce: async (options) => {
          calls.push(options);
          return { status: 'idle' };
        },
      }),
    });

    assert.equal(runtime.start({ enabled: false }), false);
    assert.equal(runtime.start({ enabled: true, claimLimit: 12, tokenLimit: 3 }), true);
    await clock.pending.shift().callback();
    await runtime.stop();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].claimLimit, 12);
    assert.equal(calls[0].tokenLimit, 3);
  });

  it('refreshes pools per batch while reusing the WETH quote reader', async () => {
    const clock = scheduler();
    const clientOptions = [];
    const adapters = [];
    const quoteReaders = [];
    let poolLoads = 0;
    const runtime = createRobinhoodBackfillEnrichmentRuntime({
      ...clock,
      logger: { error() {} },
      clientFactory: (options) => {
        clientOptions.push(options);
        return {
          providers: options.providers.map(({ name }) => name),
          request() {},
          requestProvider: async () => '0x1237',
          getMetrics: () => ({}),
        };
      },
      repositoryFactory: () => ({
        listActivePools: async () => [{ market_key: `pool-${++poolLoads}` }],
      }),
      quoteReaderFactory: (input) => {
        const reader = { rpcClient: input.rpcClient };
        quoteReaders.push(reader);
        return reader;
      },
      adapterFactory: (input) => {
        adapters.push(input);
        return { prepareClaim() {}, buildEntry() {} };
      },
      workerFactory: () => ({ runOnce: async () => ({ status: 'completed' }) }),
    });

    assert.equal(runtime.start({ enabled: true, drpcRpcUrl: 'https://drpc.example' }), true);
    assert.equal(runtime.start({ enabled: true, drpcRpcUrl: 'ignored' }), false);
    await clock.pending.shift().callback();
    await clock.pending.shift().callback();
    await runtime.stop();

    assert.deepEqual(clientOptions[0].providers, [{
      name: 'drpc', url: 'https://drpc.example',
    }]);
    assert.equal(poolLoads, 2);
    assert.equal(adapters[0].rpcProvider, 'drpc');
    assert.equal(adapters[0].timestampProvider, 'drpc');
    assert.equal(adapters[0].seedPools[0].market_key, 'pool-1');
    assert.equal(adapters[1].seedPools[0].market_key, 'pool-2');
    assert.equal(quoteReaders.length, 1);
    assert.equal(adapters[0].quoteReader, quoteReaders[0]);
    assert.equal(adapters[1].quoteReader, quoteReaders[0]);
    assert.equal(runtime.getStatus().totals.runs, 2);
    assert.equal(clock.cancelled.length, 1);
  });

  it('routes only timestamps through Alchemy with automatic dRPC fallback', async () => {
    const clock = scheduler();
    const calls = [];
    let adapterInput;
    const runtime = createRobinhoodBackfillEnrichmentRuntime({
      ...clock,
      logger: { error() {} },
      clientFactory: (options) => ({
        providers: options.providers.map(({ name }) => name),
        requestProvider: async (provider, method) => {
          calls.push({ kind: 'single', providers: [provider], method });
          return method === 'eth_chainId' ? '0x1237' : 'drpc-result';
        },
        requestBatchProvider: async () => ['drpc-batch'],
        requestProviders: async (providers, method, _params, requestOptions) => {
          calls.push({ kind: 'fallback', providers, method, requestOptions });
          return 'alchemy-result';
        },
        requestBatchProviders: async (providers, requests, requestOptions) => {
          calls.push({ kind: 'batch-fallback', providers, requests, requestOptions });
          return ['alchemy-batch'];
        },
        getMetrics: () => ({ 'alchemy-free': { requests: 1 } }),
      }),
      repositoryFactory: () => ({ listActivePools: async () => [] }),
      adapterFactory: (input) => {
        adapterInput = input;
        return { prepareClaim() {}, buildEntry() {} };
      },
      workerFactory: () => ({ runOnce: async () => ({ status: 'idle' }) }),
    });

    assert.throws(() => runtime.start({
      enabled: true,
      drpcRpcUrl: 'https://drpc.example',
      alchemyTimestampsEnabled: true,
    }), /ROBINHOOD_ALCHEMY_RPC_URL/);
    runtime.start({
      enabled: true,
      drpcRpcUrl: 'https://drpc.example',
      alchemyRpcUrl: 'https://alchemy.example',
      alchemyTimestampsEnabled: true,
    });
    await clock.pending.shift().callback();
    assert.equal(adapterInput.rpcProvider, 'drpc');
    assert.equal(adapterInput.timestampProvider, 'alchemy-free');
    assert.deepEqual(adapterInput.rpcClient.providers, ['alchemy-free', 'drpc']);
    assert.equal(runtime.getStatus().timestampProvider, 'alchemy-free');

    await adapterInput.rpcClient.request('eth_call', []);
    await adapterInput.rpcClient.requestProvider(
      'alchemy-free', 'eth_getBlockByNumber', ['0x1', false]
    );
    await adapterInput.rpcClient.requestBatchProvider(
      'alchemy-free', [{ method: 'eth_getBlockByNumber', params: ['0x1', false] }]
    );
    assert.deepEqual(calls.at(-2).providers, ['alchemy-free', 'drpc']);
    assert.equal(calls.at(-2).requestOptions.fallbackOnRpcError, true);
    assert.deepEqual(calls.at(-1).providers, ['alchemy-free', 'drpc']);
    assert.deepEqual(calls.find(({ method }) => method === 'eth_call').providers, ['drpc']);
    await runtime.stop();
  });

  it('waits for finalization in flight and does not reschedule after stop', async () => {
    const clock = scheduler();
    let finish;
    const runtime = createRobinhoodBackfillFinalizerRuntime({
      ...clock,
      logger: { error() {} },
      finalizerFactory: () => ({
        runOnce: () => new Promise((resolve) => { finish = resolve; }),
      }),
    });

    assert.equal(runtime.start({ enabled: true, limit: 25 }), true);
    const cycle = clock.pending.shift().callback();
    const stopping = runtime.stop();
    finish({ status: 'waiting' });
    await Promise.all([cycle, stopping]);

    assert.equal(runtime.getStatus().running, false);
    assert.equal(runtime.getStatus().inFlight, false);
    assert.equal(clock.pending.length, 0);
  });

  it('runs the watchdog independently with a bounded stale-query threshold', async () => {
    const clock = scheduler();
    const calls = [];
    const runtime = createRobinhoodBackfillWatchdogRuntime({
      ...clock,
      logger: { error() {} },
      watchdogFactory: () => ({
        async runOnce(options) {
          calls.push(options);
          return { status: 'healthy' };
        },
      }),
    });

    assert.equal(runtime.start({
      enabled: true,
      intervalMs: 5000,
      staleQueryThresholdMs: 25_000,
    }), true);
    await clock.pending.shift().callback();

    assert.deepEqual(calls, [{ staleQueryThresholdMs: 25_000 }]);
    assert.equal(runtime.getStatus().lastResult.status, 'healthy');
    assert.equal(clock.pending.length, 1);

    await runtime.stop();
    assert.equal(runtime.getStatus().running, false);
  });
});
