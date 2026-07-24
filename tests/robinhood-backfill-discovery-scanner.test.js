const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createRobinhoodBackfillDiscoveryScanner, __private }
  = require('../src/services/robinhood-backfill-discovery-scanner');
const HASH = `0x${'a'.repeat(64)}`;
describe('Robinhood backfill discovery scanner', () => {
  it('is inert by default and bounds provider-specific configuration', () => {
    const scanner = createRobinhoodBackfillDiscoveryScanner();
    assert.equal(scanner.start(), false);
    assert.throws(() => __private.normalizeOptions(
      { scanProvider: 'alchemy', rangeSize: 11 }
    ), /cannot exceed 10 blocks/);
    assert.equal(__private.normalizeOptions({ maxRangesPerPoll: 999 }).maxRangesPerPoll, 100);
  });
  it('resumes from discovery_scan, routes providers and halts on checkpoint reorg', async () => {
    const scheduled = [], providerCalls = [], commits = [], cursors = [];
    let watermark = null;
    let reorg = false;
    const worker = createRobinhoodBackfillDiscoveryScanner({
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return { unref() {} };
      },
      cancelSchedule() {},
      logger: { error() {} },
      clientFactory: () => ({
        getMetrics: () => ({ drpc: { requests: 2 } }),
        async requestProvider(provider, method) {
          providerCalls.push(`${provider}:${method}`);
          return method === 'eth_chainId' ? '0x1237' : method;
        },
      }),
      captureRepositoryFactory: () => ({ loadDiscoveryScanWatermark: async () => watermark }),
      catalogRepositoryFactory: () => ({
        listActivePools: async () => [],
        commitDiscoveryRange: async (input) => commits.push(input),
      }),
      async runnerFactory({ repository, rpcClient }) {
        cursors.push(await repository.loadCursor('discovery'));
        await rpcClient.request('eth_blockNumber');
        await rpcClient.request('eth_getBlockByNumber', ['0x64', false]);
        return {
          async runBatch() {
            if (reorg) throw Object.assign(
              new Error('checkpoint changed'), { code: 'persistent_reorg' }
            );
            await repository.commitDiscoveryRange({
              entries: [], cursor: { fromBlock: '100', toBlock: '100',
                nextBlock: '101', logs: [],
                checkpoint: { number: '100', hash: HASH, timestampMs: 1000 } },
            });
            return { poller: { nextBlock: '101' } };
          },
        };
      },
    });
    const options = { enabled: true, startBlock: 100, scanProvider: 'drpc',
      headProvider: 'public', drpcRpcUrl: 'https://drpc.test' };
    worker.start(options);
    await scheduled.shift().callback();
    assert.equal(commits[0].backfillCapture.provider, 'drpc');
    assert.deepEqual(providerCalls.slice(-2),
      ['robinhood-public:eth_blockNumber', 'drpc:eth_getBlockByNumber']);
    await worker.stop();
    watermark = { nextBlock: '101', checkpointBlock: '100', checkpointHash: HASH,
      checkpointTimestamp: '1970-01-01T00:00:01.000Z' };
    reorg = true;
    worker.start(options);
    await scheduled.shift().callback();
    assert.equal(cursors[1].checkpoint_hash, HASH);
    assert.equal(worker.getStatus().halted, true);
  });
});
