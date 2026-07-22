const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodIngestionWorker,
  __private,
} = require('../src/services/robinhood-ingestion-worker');

function snapshot() {
  return {
    mode: 'continuous-persistent',
    marketLogFilterMode: 'topics-only',
    coverage: { caughtUp: true, discoveryCursor: '101', marketCursor: '101' },
    pipeline: {
      tracked: { v2: 1, v3: 2, v4: 3 },
      metrics: { noxa: { seen: 2, accepted: 1, rejected: 1 } },
      enrichment: { timestamps: { rpcBatchRequests: 2 } },
      inMemoryState: {
        rollbackEnabled: false,
        observations: 0,
        windowAggregationEnabled: false,
        windowEvents: 0,
      },
    },
    runner: { cycles: 1, errors: 0 },
    rpc: { 'robinhood-public': { requests: 4 } },
  };
}

function createHarness(runner, overrides = {}) {
  const callbacks = [];
  const worker = createRobinhoodIngestionWorker({
    schedule: (callback, delayMs) => {
      callbacks.push({ callback, delayMs });
      return { unref() {} };
    },
    cancelSchedule: () => {},
    logger: { error() {} },
    clientFactory: () => ({
      providers: ['robinhood-public'],
      requestProvider: async () => '0x1237',
      request() {},
    }),
    repositoryFactory: () => ({}),
    runnerFactory: async () => runner,
    ...overrides,
  });
  return { callbacks, worker };
}

describe('Robinhood ingestion worker', () => {
  it('stays inactive by default and only schedules after explicit enablement', () => {
    const { callbacks, worker } = createHarness({ pollOnce: async () => snapshot() });

    assert.equal(worker.start(), false);
    assert.equal(worker.getStatus().running, false);
    assert.equal(callbacks.length, 0);
    assert.equal(worker.start({ enabled: true, pollIntervalMs: 500 }), true);
    assert.equal(callbacks[0].delayMs, 0);
  });

  it('polls persistent ingestion, publishes compact status and reschedules normally', async () => {
    const { callbacks, worker } = createHarness({ pollOnce: async () => snapshot() });
    worker.start({ enabled: true, pollIntervalMs: 500 });

    await callbacks.shift().callback();
    const status = worker.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.consecutiveErrors, 0);
    assert.deepEqual(status.lastSnapshot.tracked, { v2: 1, v3: 2, v4: 3 });
    assert.deepEqual(status.lastSnapshot.noxa, { seen: 2, accepted: 1, rejected: 1 });
    assert.equal(status.lastSnapshot.marketLogFilterMode, 'topics-only');
    assert.equal(status.lastSnapshot.enrichment.timestamps.rpcBatchRequests, 2);
    assert.equal(status.lastSnapshot.inMemoryState.rollbackEnabled, false);
    assert.equal(status.lastSnapshot.inMemoryState.windowEvents, 0);
    assert.equal(callbacks[0].delayMs, 500);
    await worker.stop();
  });

  it('backs off transient errors but halts on a persistent reorg', async () => {
    const propagated = [];
    const errors = [Object.assign(new Error('temporary'), { code: 'timeout' }),
      Object.assign(new Error('checkpoint changed'), { code: 'persistent_reorg' })];
    const { callbacks, worker } = createHarness({
      pollOnce: async () => { throw errors.shift(); },
    });
    worker.start({
      enabled: true,
      pollIntervalMs: 500,
      maxErrorBackoffMs: 5000,
      onFatal: async (error) => propagated.push(error.code),
    });

    await callbacks.shift().callback();
    assert.equal(worker.getStatus().running, true);
    assert.equal(callbacks[0].delayMs, 1000);
    await callbacks.shift().callback();
    assert.equal(worker.getStatus().running, false);
    assert.equal(worker.getStatus().halted, true);
    assert.deepEqual(propagated, ['persistent_reorg']);
    assert.equal(callbacks.length, 0);
  });

  it('validates every RPC chain before constructing persistence', async () => {
    let repositoryConstructions = 0;
    const { callbacks, worker } = createHarness(
      { pollOnce: async () => snapshot() },
      {
        clientFactory: () => ({
          providers: ['robinhood-public', 'alchemy-free'],
          requestProvider: async (providerName) => (
            providerName === 'robinhood-public' ? '0x1237' : '0x1'
          ),
        }),
        repositoryFactory: () => {
          repositoryConstructions += 1;
          return {};
        },
      }
    );

    worker.start({ enabled: true });
    await callbacks.shift().callback();

    const status = worker.getStatus();
    assert.equal(repositoryConstructions, 0);
    assert.equal(status.halted, true);
    assert.equal(status.lastError.code, 'configuration_error');
    assert.match(status.lastError.message, /alchemy-free is on chain 1; expected 4663/);
  });

  it('injects post-commit market and standard alert consumers into persistence', async () => {
    let repositoryOptions = null;
    const emitMarketBucketUpdate = () => true;
    const standardAlertSignalConsumer = async () => {};
    const { callbacks, worker } = createHarness(
      { pollOnce: async () => snapshot() },
      { repositoryFactory: (options) => { repositoryOptions = options; return {}; } },
    );

    worker.start({ enabled: true, emitMarketBucketUpdate, standardAlertSignalConsumer });
    await callbacks.shift().callback();

    assert.equal(repositoryOptions.emitMarketBucketUpdate, emitMarketBucketUpdate);
    assert.equal(repositoryOptions.standardAlertSignalConsumer, standardAlertSignalConsumer);
    await worker.stop();
  });

  it('uses Robinhood public RPC first and only adds configured Alchemy fallback', () => {
    const publicOnly = __private.normalizeOptions({ enabled: true });
    assert.equal(publicOnly.publicRpcUrl, 'https://rpc.mainnet.chain.robinhood.com');
    assert.equal(publicOnly.useAlchemy, false);
    assert.equal(publicOnly.marketLogFilterMode, 'topics-only');
    assert.equal(publicOnly.rpcMinIntervalMs, 250);
    assert.equal(publicOnly.observationConcurrency, 1);
    assert.throws(
      () => __private.createClient({ ...publicOnly, useAlchemy: true }),
      (error) => error.code === 'configuration_error'
    );

    const client = __private.createClient({
      ...publicOnly,
      useAlchemy: true,
      alchemyRpcUrl: 'https://example.invalid/rpc',
    });
    assert.deepEqual(client.providers, ['robinhood-public', 'alchemy-free']);
  });

  it('supports dRPC fallback alongside Alchemy with configurable order', () => {
    const base = __private.normalizeOptions({ enabled: true });
    assert.equal(base.useDrpc, false);
    assert.equal(base.fallbackOrder, 'drpc,alchemy');

    const drpcOnly = __private.createClient({
      ...base,
      useDrpc: true,
      drpcRpcUrl: 'https://example.invalid/drpc',
    });
    assert.deepEqual(drpcOnly.providers, ['robinhood-public', 'drpc']);

    const both = __private.createClient({
      ...base,
      useAlchemy: true,
      alchemyRpcUrl: 'https://example.invalid/rpc',
      useDrpc: true,
      drpcRpcUrl: 'https://example.invalid/drpc',
    });
    assert.deepEqual(both.providers, ['robinhood-public', 'drpc', 'alchemy-free']);

    const alchemyFirst = __private.createClient({
      ...base,
      fallbackOrder: 'alchemy,drpc',
      useAlchemy: true,
      alchemyRpcUrl: 'https://example.invalid/rpc',
      useDrpc: true,
      drpcRpcUrl: 'https://example.invalid/drpc',
    });
    assert.deepEqual(alchemyFirst.providers, ['robinhood-public', 'alchemy-free', 'drpc']);

    assert.throws(
      () => __private.createClient({ ...base, useDrpc: true }),
      (error) => error.code === 'configuration_error'
    );
    assert.throws(
      () => __private.createClient({ ...base, fallbackOrder: 'drpc,helius' }),
      (error) => error.code === 'configuration_error'
    );
  });
});
