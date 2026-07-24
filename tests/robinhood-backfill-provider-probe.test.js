const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  configuredProviders,
  findDivergences,
  parseIntegerList,
  runBackfillProviderProbe,
} = require('../src/utils/robinhood-backfill-provider-probe');

function createClient(options = {}) {
  const metrics = {};
  const providers = ['robinhood-public', 'drpc', 'alchemy-free'];
  function record(provider, method, responseBytes = 20, failed = false) {
    metrics[provider] ||= {};
    metrics[provider][method] ||= {
      requests: 0, successes: 0, errors: 0, requestBytes: 0, responseBytes: 0,
    };
    const entry = metrics[provider][method];
    entry.requests += 1;
    entry.successes += failed ? 0 : 1;
    entry.errors += failed ? 1 : 0;
    entry.requestBytes += 10;
    entry.responseBytes += responseBytes;
  }
  return {
    providers,
    getMetrics: () => structuredClone(metrics),
    async requestProvider(provider, method, params) {
      if (method === 'eth_blockNumber') {
        if (options.failHeadProvider === provider) throw new Error('offline');
        return '0x3e8';
      }
      if (method === 'eth_chainId') return '0x1237';
      if (method !== 'eth_getLogs') throw new Error(`Unexpected method ${method}`);
      const fromBlock = params[0].fromBlock;
      if (options.failProvider === provider) {
        record(provider, method, 0, true);
        const error = new Error('limited');
        error.code = 'rate_limited';
        error.httpStatus = 429;
        throw error;
      }
      record(provider, method);
      const suffix = options.divergentProvider === provider ? 'different' : fromBlock;
      return [{
        transactionHash: `tx-${suffix}`,
        logIndex: '0x0',
        blockHash: `block-${fromBlock}`,
      }];
    },
    async requestBatchProvider(provider, requests) {
      record(provider, 'eth_getBlockByNumber:batch', 50);
      return requests.map(() => ({ timestamp: '0x10' }));
    },
  };
}

describe('Robinhood backfill provider probe', () => {
  it('loads only configured providers and parses bounded unique matrices', () => {
    assert.deepEqual(configuredProviders({
      ROBINHOOD_RPC_URL: 'https://public.test',
      ROBINHOOD_DRPC_RPC_URL: 'https://drpc.test',
    }).map(({ name }) => name), ['robinhood-public', 'drpc']);
    assert.deepEqual(parseIntegerList('1000,5000,1000', [], 10000, 'ranges'), [1000, 5000]);
    assert.throws(() => parseIntegerList('0,20000', [], 10000, 'ranges'), /no valid values/);
  });

  it('compares identical ranges without fallback and reports throughput and traffic', async () => {
    const report = await runBackfillProviderProbe({
      providers: [
        { name: 'robinhood-public', url: 'https://public.test' },
        { name: 'drpc', url: 'https://drpc.test' },
        { name: 'alchemy-free', url: 'https://alchemy.test' },
      ],
      client: createClient(),
      confirmations: 2,
      rangeSizes: [100],
      inFlight: [2],
      samples: 1,
    });

    assert.equal(report.complete, true);
    assert.equal(report.safeHead, '998');
    assert.equal(report.startBlock, '799');
    assert.deepEqual(report.divergences, []);
    assert.equal(report.providers.length, 3);
    assert.equal(report.providers[0].scenarios.length, 2);
    assert.equal(report.providers[0].scenarios[0].samples, 2);
    assert.equal(report.providers[0].scenarios[0].logs, 2);
    assert.equal(report.providers[0].scenarios[0].traffic.requests, 2);
    assert.equal(report.providers[0].scenarios[0].blocksPerMinute > 0, true);
    assert.equal(report.costUnits.available, false);
  });

  it('surfaces provider failures and identity divergence as incomplete', async () => {
    const baseOptions = {
      providers: [
        { name: 'robinhood-public', url: 'https://public.test' },
        { name: 'drpc', url: 'https://drpc.test' },
      ],
      confirmations: 2,
      rangeSizes: [100],
      inFlight: [1],
      samples: 1,
    };
    const failed = await runBackfillProviderProbe({
      ...baseOptions,
      client: createClient({ failProvider: 'drpc' }),
    });
    assert.equal(failed.complete, false);
    assert.equal(failed.providers[1].scenarios[0].traffic.errors, 1);
    assert.equal(failed.providers[1].scenarios[0].ranges[0].error.httpStatus, 429);

    const divergent = await runBackfillProviderProbe({
      ...baseOptions,
      client: createClient({ divergentProvider: 'drpc' }),
    });
    assert.equal(divergent.complete, false);
    assert.equal(divergent.divergences.length, 2);

    const unavailable = await runBackfillProviderProbe({
      ...baseOptions,
      client: createClient({ failHeadProvider: 'robinhood-public' }),
    });
    assert.equal(unavailable.complete, false);
    assert.equal(unavailable.heads['robinhood-public'], null);
    assert.equal(unavailable.providers[1].scenarios.length, 2);
  });

  it('requires dRPC and detects mismatched fingerprints', async () => {
    await assert.rejects(
      () => runBackfillProviderProbe({ providers: [{ name: 'robinhood-public', url: 'x' }] }),
      /DRPC_RPC_URL is required/
    );
    assert.equal(findDivergences([
      { provider: 'a', scenarios: [{ stream: 'market', ranges: [{ ok: true, fromBlock: '1', toBlock: '2', fingerprint: 'a' }] }] },
      { provider: 'b', scenarios: [{ stream: 'market', ranges: [{ ok: true, fromBlock: '1', toBlock: '2', fingerprint: 'b' }] }] },
    ]).length, 1);
  });
});
