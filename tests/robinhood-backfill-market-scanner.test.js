const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodBackfillMarketScanner,
  __private,
} = require('../src/services/robinhood-backfill-market-scanner');
const capturePrivate = require('../src/models/robinhood-backfill-capture').__private;
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');
const POOL = `0x${'a'.repeat(40)}`;
const UNKNOWN = `0x${'b'.repeat(40)}`;
const HASH = `0x${'c'.repeat(64)}`;
function scheduler() {
  const entries = [];
  return {
    entries,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      entries.push(timer);
      return timer;
    },
    cancelSchedule() {},
  };
}
function createHarness(overrides = {}) {
  const clock = scheduler();
  const calls = [];
  const captures = [];
  const client = {
    getMetrics: () => ({ drpc: { eth_getLogs: { requests: 1 } } }),
    async requestProvider(provider, method, params) {
      calls.push({ provider, method, params });
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_blockNumber') return '0x96';
      if (method === 'eth_getLogs') {
        return [
          {
            address: POOL, transactionHash: HASH, logIndex: '0x0',
            blockNumber: '0x65', blockHash: HASH, transactionIndex: '0x0',
            topics: [v3.TOPICS.swap], data: '0x',
          },
          {
            address: UNKNOWN, transactionHash: HASH, logIndex: '0x1',
            blockNumber: '0x66', blockHash: HASH, transactionIndex: '0x0',
            topics: [v3.TOPICS.swap], data: '0x',
          },
        ];
      }
      if (method === 'eth_getBlockByNumber') {
        return { number: params[0], hash: HASH, timestamp: '0x64' };
      }
      throw new Error(`Unexpected ${method}`);
    },
  };
  const scanner = createRobinhoodBackfillMarketScanner({
    ...clock,
    logger: { error() {} },
    clientFactory: () => client,
    captureRepositoryFactory: () => ({
      loadMarketScanWatermark: async () => null,
      loadDiscoveryScanWatermark: async () => (
        { nextBlock: String(overrides.discoveryNextBlock ?? 1000) }
      ),
      getBacklogSummary: async () => ({
        pending: 0, leased: 0, blocked: 0, terminal: 0, oldestOpenBlock: null,
      }),
      async captureMarketRange(input) {
        captures.push(input);
        return { insertedLogs: input.logs.length };
      },
    }),
    catalogRepositoryFactory: () => ({
      loadCursor: async () => ({ next_block: '1000' }),
      listActivePools: async () => [{
        protocol: 'uniswap-v3',
        market_key: 'robinhood:uniswap-v3:test',
        pool_address: POOL,
      }],
    }),
    ...overrides,
  });
  return { calls, captures, clock, scanner };
}
describe('Robinhood backfill market scanner', () => {
  it('is disabled by default and validates provider-specific limits', () => {
    const { clock, scanner } = createHarness();
    assert.equal(scanner.start(), false);
    assert.equal(clock.entries.length, 0);
    assert.throws(
      () => __private.normalizeOptions({
        enabled: true, scanProvider: 'alchemy', rangeSize: 100,
      }),
      /cannot exceed 10 blocks/
    );
    let clientOptions;
    __private.createClient(__private.normalizeOptions({
      scanProvider: 'drpc',
      drpcRpcUrl: 'https://drpc.test',
      rpcTimeoutMs: 27_000,
      rpcMaxRetries: 3,
      rpcMinIntervalMs: 125,
    }), (input) => { clientOptions = input; return {}; });
    assert.equal(clientOptions.timeoutMs, 27_000);
    assert.equal(clientOptions.maxRetries, 3);
    assert.deepEqual(
      clientOptions.providers.map(({ name, minRequestIntervalMs }) => (
        [name, minRequestIntervalMs]
      )),
      [['robinhood-public', 125], ['drpc', 125]]
    );
  });
  it('routes head to public, scan to dRPC and captures only registered markets', async () => {
    const { calls, captures, clock, scanner } = createHarness();
    assert.equal(scanner.start({
      enabled: true,
      startBlock: 100,
      rangeSize: 10,
      scanProvider: 'drpc',
      headProvider: 'public',
    }), true);
    await clock.entries[0].callback();
    assert.deepEqual(
      calls.filter(({ method }) => method !== 'eth_chainId')
        .map(({ provider, method }) => `${provider}:${method}`),
      [
        'robinhood-public:eth_blockNumber',
        'drpc:eth_getLogs',
        'drpc:eth_getBlockByNumber',
      ]
    );
    assert.equal(captures[0].fromBlock, '100');
    assert.equal(captures[0].toBlock, '109');
    assert.equal(captures[0].rawLogCount, 2);
    assert.equal(captures[0].logs.length, 1);
    assert.doesNotThrow(() => capturePrivate.normalizeCapture(captures[0]));
    assert.equal(captures[0].logs[0].protocol, 'uniswap-v3');
    assert.equal(scanner.getStatus().lastRange.trackedLogs, 1);
    assert.equal(scanner.getStatus().totals.blocks, 10);
    assert.equal(clock.entries[1].delayMs, 2000);
    await scanner.stop();
  });
  it('keeps one range in flight and caps market coverage at discovery', async () => {
    let releaseHead;
    let headCalls = 0;
    const { scanner } = createHarness({
      clientFactory: () => ({
        getMetrics: () => ({}),
        async requestProvider(_provider, method) {
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'eth_blockNumber') {
            headCalls += 1;
            return new Promise((resolve) => { releaseHead = resolve; });
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
      catalogRepositoryFactory: () => ({
        loadCursor: async () => ({ next_block: '100' }),
        listActivePools: async () => [],
      }),
      discoveryNextBlock: 100,
    });
    scanner.start({ enabled: true, startBlock: 100 });
    const first = scanner.runOnce();
    const joined = scanner.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    releaseHead('0x96');
    const [left, right] = await Promise.all([first, joined]);
    assert.equal(headCalls, 1);
    assert.deepEqual(left, right);
    assert.equal(left.caughtUp, false);
    assert.equal(left.blockedByDiscovery, true);
    assert.equal(left.safeHead, '99');
    await scanner.stop();
  });
  it('reports discovery blocking, recognizes V4 pools and rebuilds clients after restart', async () => {
    const roles = [];
    const { scanner } = createHarness({
      clientFactory(options) {
        roles.push(options.scanProvider);
        return {
          getMetrics: () => ({ role: options.scanProvider }),
          async requestProvider(_provider, method) {
            if (method === 'eth_chainId') return '0x1237';
            if (method === 'eth_blockNumber') return '0x96';
            throw new Error(`Unexpected ${method}`);
          },
        };
      },
      catalogRepositoryFactory: () => ({
        loadCursor: async () => ({ next_block: '105' }),
        listActivePools: async () => [],
      }),
      discoveryNextBlock: 105,
    });
    scanner.start({ enabled: true, startBlock: 110, scanProvider: 'drpc' });
    const blocked = await scanner.runOnce();
    await scanner.stop();
    scanner.start({
      enabled: true,
      startBlock: 151,
      scanProvider: 'alchemy',
      alchemyRpcUrl: 'https://alchemy.test',
      rangeSize: 10,
    });
    const caughtUp = await scanner.runOnce();
    assert.deepEqual(roles, ['drpc', 'alchemy']);
    assert.equal(blocked.caughtUp, false);
    assert.equal(blocked.blockedByDiscovery, true);
    assert.equal(caughtUp.caughtUp, true);
    const tracked = __private.selectTrackedLogs([{
      address: v4.ROBINHOOD_V4_POOL_MANAGER,
      topics: [v4.TOPICS.modifyLiquidity, HASH],
    }], [{ protocol: 'uniswap-v4', market_key: 'rh:v4:test', pool_id: HASH }]);
    assert.equal(tracked[0].marketKey, 'rh:v4:test');
    await scanner.stop();
  });
  it('publishes RPC metrics when a provider request fails', async () => {
    const { scanner } = createHarness({
      clientFactory: () => ({
        getMetrics: () => ({ drpc: { eth_blockNumber: { errors: 1 } } }),
        async requestProvider(_provider, method) {
          if (method === 'eth_chainId') return '0x1237';
          throw new Error('head unavailable');
        },
      }),
    });
    scanner.start({ enabled: true, startBlock: 100 });
    await assert.rejects(scanner.runOnce(), /head unavailable/);
    assert.equal(scanner.getStatus().rpc.drpc.eth_blockNumber.errors, 1);
    await scanner.stop();
  });
  it('prefetches responses in parallel but commits them in block order', async () => {
    const releases = new Map();
    const { captures, scanner } = createHarness({
      clientFactory: () => ({
        getMetrics: () => ({}),
        async requestProvider(_provider, method, params) {
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'eth_blockNumber') return '0x96';
          if (method === 'eth_getLogs') {
            return new Promise((resolve) => releases.set(params[0].fromBlock, resolve));
          }
          if (method === 'eth_getBlockByNumber') {
            return { number: params[0], hash: HASH, timestamp: '0x64' };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    scanner.start({
      enabled: true, startBlock: 100, rangeSize: 10, inFlightRanges: 3,
    });
    const run = scanner.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    releases.get('0x78')([]);
    releases.get('0x6e')([]);
    releases.get('0x64')([]);
    const summary = await run;
    assert.deepEqual(captures.map(({ fromBlock }) => fromBlock), ['100', '110', '120']);
    assert.equal(summary.ranges, 3);
    await scanner.stop();
  });
  it('commits only the successful prefix when an intermediate fetch fails', async () => {
    const { captures, scanner } = createHarness({
      clientFactory: () => ({
        getMetrics: () => ({}),
        async requestProvider(_provider, method, params) {
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'eth_blockNumber') return '0x96';
          if (method === 'eth_getLogs' && params[0].fromBlock === '0x6e') {
            throw new Error('middle range failed');
          }
          if (method === 'eth_getLogs') return [];
          if (method === 'eth_getBlockByNumber') {
            return { number: params[0], hash: HASH, timestamp: '0x64' };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    scanner.start({
      enabled: true, startBlock: 100, rangeSize: 10, inFlightRanges: 3,
    });
    await assert.rejects(scanner.runOnce(), /middle range failed/);
    assert.deepEqual(captures.map(({ fromBlock }) => fromBlock), ['100']);
    assert.equal(scanner.getStatus().totals.ranges, 1);
    await scanner.stop();
  });
  it('splits a dense range and commits the resulting leaves contiguously', async () => {
    const { captures, scanner } = createHarness({
      clientFactory: () => ({
        getMetrics: () => ({}),
        async requestProvider(_provider, method, params) {
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'eth_blockNumber') return '0x6d';
          if (method === 'eth_getLogs') {
            return params[0].fromBlock === '0x64' && params[0].toBlock === '0x6b'
              ? [{}, {}, {}]
              : [];
          }
          if (method === 'eth_getBlockByNumber') {
            return { number: params[0], hash: HASH, timestamp: '0x64' };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    scanner.start({
      enabled: true,
      startBlock: 100,
      rangeSize: 8,
      minRangeSize: 2,
      maxLogsPerRange: 2,
    });
    const summary = await scanner.runOnce();
    assert.deepEqual(
      captures.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]),
      [['100', '103'], ['104', '107']]
    );
    assert.equal(summary.ranges, 2);
    assert.equal(scanner.getStatus().totals.rangeSplits, 1);
    await scanner.stop();
  });
  it('stops accepting prefetched results at the buffer limit and pauses on durable backlog', async () => {
    const { captures, scanner } = createHarness({
      clientFactory: () => ({
        getMetrics: () => ({}),
        async requestProvider(_provider, method, params) {
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'eth_blockNumber') return '0x96';
          if (method === 'eth_getLogs') return [{}, {}, {}];
          if (method === 'eth_getBlockByNumber') {
            return { number: params[0], hash: HASH, timestamp: '0x64' };
          }
          throw new Error(`Unexpected ${method}`);
        },
      }),
    });
    scanner.start({
      enabled: true,
      startBlock: 100,
      rangeSize: 10,
      inFlightRanges: 2,
      maxLogsPerRange: 3,
      maxBufferedLogs: 5,
    });
    await assert.rejects(
      scanner.runOnce(),
      (error) => error.code === 'backfill_buffer_limit'
    );
    assert.deepEqual(captures.map(({ fromBlock }) => fromBlock), ['100']);
    await scanner.stop();

    let rpcRequests = 0;
    const backpressured = createHarness({
      clientFactory: () => ({
        getMetrics: () => ({}),
        async requestProvider() { rpcRequests += 1; return '0x1237'; },
      }),
      captureRepositoryFactory: () => ({
        getBacklogSummary: async () => ({
          pending: 10, leased: 0, blocked: 0, terminal: 0, oldestOpenBlock: '1',
        }),
        loadMarketScanWatermark: async () => null,
        captureMarketRange: async () => ({ insertedLogs: 0 }),
      }),
    }).scanner;
    backpressured.start({ enabled: true, startBlock: 100, maxPendingLogs: 10 });
    const paused = await backpressured.runOnce();
    assert.equal(paused.backpressured, true);
    assert.equal(rpcRequests, 0);
    assert.equal(backpressured.getStatus().totals.backpressurePauses, 1);
    await backpressured.stop();
  });
});
