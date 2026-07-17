const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createDiscoveryBootstrapRpcRouter,
  optionalBlock,
  readOptions,
  runDiscoveryBootstrap,
} = require('../src/utils/robinhood-discovery-bootstrap');

describe('Robinhood discovery bootstrap CLI', () => {
  it('uses a bounded batch and keeps the historical boundary explicit', () => {
    assert.equal(optionalBlock('0x10'), '16');
    assert.equal(optionalBlock('0'), '0');
    assert.throws(() => optionalBlock('latest'), /must be decimal or hex/);

    const options = readOptions({
      ROBINHOOD_DISCOVERY_BOOTSTRAP_START_BLOCK: '100',
      ROBINHOOD_DISCOVERY_BOOTSTRAP_RANGE_SIZE: '500',
      ROBINHOOD_DISCOVERY_BOOTSTRAP_MAX_RANGE_SIZE: '4000',
      ROBINHOOD_DISCOVERY_BOOTSTRAP_MAX_RANGES: '25',
      ROBINHOOD_DISCOVERY_BOOTSTRAP_USE_ALCHEMY: 'true',
      ROBINHOOD_DISCOVERY_BOOTSTRAP_ALCHEMY_MIN_INTERVAL_MS: '75',
      ROBINHOOD_ALCHEMY_RPC_URL: 'https://example.test/rpc',
    });

    assert.equal(options.startBlock, '100');
    assert.equal(options.rangeSize, 500);
    assert.equal(options.minRangeSize, 1);
    assert.equal(options.maxRangeSize, 4000);
    assert.equal(options.maxRangesPerPoll, 25);
    assert.equal(options.useAlchemy, true);
    assert.equal(options.alchemyMinIntervalMs, 75);
    assert.equal(readOptions({
      ROBINHOOD_DISCOVERY_BOOTSTRAP_RANGE_SIZE: '5000',
    }).maxRangeSize, 5000);
  });

  it('validates chain identity and reports a discovery-only non-publishable batch', async () => {
    const calls = [];
    const report = await runDiscoveryBootstrap({
      startBlock: '100',
      confirmations: 2,
      rangeSize: 250,
      minRangeSize: 1,
      maxRangeSize: 2000,
      maxRangesPerPoll: 100,
    }, {
      rpcClient: { request: async () => '0x1237' },
      repository: { marker: 'repository' },
      validateChainIds: async () => {
        calls.push('validate');
        return { 'robinhood-public': '4663' };
      },
      runnerFactory: async (options) => {
        calls.push({ startBlock: options.startBlock, repository: options.repository.marker });
        return {
          runBatch: async () => ({
            mode: 'discovery-bootstrap-persistent',
            status: 'backfilling',
            coverageStartBlock: '100',
            targetBlock: '1000',
            remainingBlocks: '500',
            tracked: { v2: 3, v3: 4, v4: 5 },
            rpc: {},
            poller: {
              nextBlock: '501',
              rangeSize: 500,
              metrics: {
                ranges: 10,
                blocksProcessed: 400,
                logsReceived: 12,
                logsAccepted: 12,
                rangeShrinks: 1,
                rangeGrows: 2,
              },
            },
          }),
        };
      },
    });

    assert.deepEqual(calls, [
      'validate',
      { startBlock: '100', repository: 'repository' },
    ]);
    assert.equal(report.status, 'backfilling');
    assert.equal(report.historicalNoxaEnrichment, false);
    assert.equal(report.marketWriterEnabled, false);
    assert.equal(report.publishable, false);
    assert.deepEqual(report.providerChainIds, { 'robinhood-public': '4663' });
  });

  it('routes large log scans to public RPC and individual block reads to Alchemy', async () => {
    const calls = [];
    const delays = [];
    let now = 1000;
    const client = {
      providers: ['robinhood-public', 'alchemy-free'],
      requestProvider: async (provider, method, params, requestOptions) => {
        calls.push({ provider, method, params, requestOptions });
        return method;
      },
      getMetrics: () => ({ marker: true }),
    };
    const router = createDiscoveryBootstrapRpcRouter(client, {
      useAlchemy: true,
      alchemyMinIntervalMs: 50,
      now: () => now,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        now += delayMs;
      },
    });
    const signal = new AbortController().signal;

    assert.equal(await router.request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x100' }]), 'eth_getLogs');
    assert.deepEqual(await Promise.all([
      router.request('eth_blockNumber'),
      router.request('eth_getBlockByNumber', ['0x100', false], { signal }),
    ]), ['eth_blockNumber', 'eth_getBlockByNumber']);
    assert.deepEqual(calls.map(({ provider, method }) => ({ provider, method })), [
      { provider: 'robinhood-public', method: 'eth_getLogs' },
      { provider: 'alchemy-free', method: 'eth_blockNumber' },
      { provider: 'alchemy-free', method: 'eth_getBlockByNumber' },
    ]);
    assert.equal(calls[2].requestOptions.signal, signal);
    assert.deepEqual(delays, [50]);
    assert.deepEqual(router.getMetrics(), { marker: true });
  });

  it('fails closed when hybrid routing is enabled without both named providers', () => {
    assert.throws(
      () => createDiscoveryBootstrapRpcRouter({ providers: [], requestProvider() {} }, { useAlchemy: true }),
      (error) => error.code === 'configuration_error'
    );
  });
});
