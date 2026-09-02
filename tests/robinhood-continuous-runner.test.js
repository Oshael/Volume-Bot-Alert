const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  BOOTSTRAP_DISCOVERY_ADDRESSES,
  BOOTSTRAP_DISCOVERY_TOPICS,
  DISCOVERY_ADDRESSES,
  DISCOVERY_TOPICS,
  MARKET_TOPICS,
  createRobinhoodContinuousRunner,
  createRobinhoodDiscoveryBootstrapRunner,
  summarizeRpcMetrics,
} = require('../src/services/robinhood-continuous-runner');
const v4 = require('../src/services/uniswap-v4-decoder');
const noxa = require('../src/services/noxa-launch-decoder');

const NEW_POOL = '0x1111111111111111111111111111111111111111';

function createPipeline() {
  const addresses = [v4.ROBINHOOD_V4_POOL_MANAGER];
  const calls = { discovery: 0, market: 0, removedDiscovery: 0, removedMarket: 0 };
  return {
    calls,
    getTrackedMarketAddresses: () => [...addresses],
    processDiscoveryLogs: async () => {
      calls.discovery += 1;
      if (!addresses.includes(NEW_POOL)) addresses.push(NEW_POOL);
    },
    processMarketLogs: async () => { calls.market += 1; },
    processRemovedDiscoveryLogs: () => { calls.removedDiscovery += 1; },
    processRemovedLogs: () => { calls.removedMarket += 1; },
    snapshot: () => ({ tracked: { v2: 1, v3: 1, v4: 1 }, metrics: {}, windows: [] }),
  };
}

function createClient(options = {}) {
  const filters = [];
  let marketFailures = options.marketFailures || 0;
  const heads = [...(options.heads || [])];
  return {
    filters,
    providers: options.providers || ['robinhood-public'],
    getMetrics: () => options.metrics || {},
    request: async (method, params) => {
      if (method === 'eth_blockNumber') return heads.length ? heads.shift() : '0x65';
      if (method === 'eth_getBlockByNumber') {
        return { hash: `0xhash${params[0]}`, timestamp: options.blockTimestamp };
      }
      if (method === 'eth_getLogs') {
        const filter = params[0];
        filters.push(filter);
        const isMarket = filter.topics[0] === MARKET_TOPICS;
        if (isMarket && marketFailures > 0) {
          marketFailures -= 1;
          throw options.marketFailureError || new Error('temporary market failure');
        }
        return options.logs?.(filter) || [];
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
}

describe('Robinhood continuous runner', () => {
  it('starts both live pollers with a 100-block catch-up range by default', async () => {
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient(),
      pipeline: createPipeline(),
      startBlock: 100,
      confirmations: 0,
    });

    const snapshot = runner.snapshot();
    assert.equal(snapshot.pollers.discovery.rangeSize, 100);
    assert.equal(snapshot.pollers.market.rangeSize, 100);
  });

  it('bootstraps only discovery and persists empty ranges without starting market', async () => {
    const commits = [];
    const repository = {
      loadCursor: async () => null,
      listActivePools: async () => [],
      commitDiscoveryRange: async (range) => commits.push(range),
    };
    const client = createClient({ heads: ['0x65', '0x65'] });
    const runner = await createRobinhoodDiscoveryBootstrapRunner({
      rpcClient: client,
      repository,
      pipeline: createPipeline(),
      startBlock: 100,
      confirmations: 0,
      rangeSize: 2,
      minRangeSize: 2,
      maxRangeSize: 2,
      maxRangesPerPoll: 1,
    });

    const snapshot = await runner.runBatch();

    assert.equal(snapshot.mode, 'discovery-bootstrap-persistent');
    assert.equal(snapshot.status, 'caught-up');
    assert.equal(snapshot.coverageStartBlock, '100');
    assert.equal(snapshot.remainingBlocks, '0');
    assert.equal(client.filters.length, 1);
    assert.deepEqual(client.filters[0].topics, [BOOTSTRAP_DISCOVERY_TOPICS]);
    assert.deepEqual(client.filters[0].address, BOOTSTRAP_DISCOVERY_ADDRESSES);
    assert.equal(BOOTSTRAP_DISCOVERY_ADDRESSES.includes(noxa.NOXA_FACTORY), false);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].entries.length, 0);
    assert.equal(commits[0].cursor.nextBlock, '102');
  });

  it('requires an explicit discovery boundary only until a cursor exists', async () => {
    const repository = {
      loadCursor: async () => null,
      listActivePools: async () => [],
      commitDiscoveryRange: async () => {},
    };
    await assert.rejects(createRobinhoodDiscoveryBootstrapRunner({
      rpcClient: createClient(),
      repository,
      pipeline: createPipeline(),
    }), (error) => error.code === 'bootstrap_start_required');

    repository.loadCursor = async () => ({ next_block: '101' });
    const runner = await createRobinhoodDiscoveryBootstrapRunner({
      rpcClient: createClient({ heads: ['0x65'] }),
      repository,
      pipeline: createPipeline(),
      confirmations: 0,
    });
    assert.equal(runner.snapshot().coverageStartBlock, '101');
  });

  it('runs discovery before market polling so dynamic pools enter the same coverage cycle', async () => {
    const pipeline = createPipeline();
    const client = createClient({
      logs: (filter) => filter.topics[0] === DISCOVERY_TOPICS ? [{
        blockNumber: '0x64',
        blockHash: `0x${'aa'.repeat(32)}`,
        transactionHash: `0x${'bb'.repeat(32)}`,
        logIndex: '0x0',
      }] : [],
    });
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: client,
      pipeline,
      startBlock: 100,
      confirmations: 0,
      rangeSize: 2,
      minRangeSize: 2,
      maxRangeSize: 2,
    });
    const snapshot = await runner.pollOnce();

    assert.equal(pipeline.calls.discovery, 1);
    assert.equal(pipeline.calls.market, 0);
    assert.deepEqual(client.filters[0].topics, [DISCOVERY_TOPICS]);
    assert.deepEqual(client.filters[0].address, DISCOVERY_ADDRESSES);
    assert.equal(DISCOVERY_ADDRESSES.includes(noxa.NOXA_FACTORY), true);
    assert.deepEqual(client.filters[1].topics, [MARKET_TOPICS]);
    assert.equal(MARKET_TOPICS.includes(v4.TOPICS.modifyLiquidity), true);
    assert.equal(client.filters[1].address.includes(NEW_POOL), true);
    assert.equal(snapshot.coverage.status, 'complete_within_declared_range');
    assert.equal(snapshot.coverage.unexplainedGaps, 0);
    assert.equal(snapshot.coverageStartBlock, '100');
  });

  it('passes the configured address batch limit to market log polling', async () => {
    const addresses = Array.from(
      { length: 5 },
      (_, index) => `0x${String(index + 1).padStart(40, '0')}`
    );
    const pipeline = createPipeline();
    pipeline.getTrackedMarketAddresses = () => addresses;
    const client = createClient();
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: client,
      pipeline,
      startBlock: 101,
      confirmations: 0,
      rangeSize: 1,
      minRangeSize: 1,
      maxRangeSize: 1,
      maxAddressesPerLogRequest: 2,
    });

    const snapshot = await runner.pollOnce();
    const marketFilters = client.filters.filter((filter) => filter.topics[0] === MARKET_TOPICS);

    assert.deepEqual(marketFilters.map((filter) => filter.address), [
      addresses.slice(0, 2),
      addresses.slice(2, 4),
      addresses.slice(4),
    ]);
    assert.equal(snapshot.pollers.market.metrics.addressShardedRanges, 1);
    assert.equal(snapshot.pollers.market.metrics.logRequests, 3);
  });

  it('can scan market topics without expanding the tracked address registry into shards', async () => {
    const pipeline = createPipeline();
    pipeline.getTrackedMarketAddresses = () => Array.from(
      { length: 250 },
      (_, index) => `0x${String(index + 1).padStart(40, '0')}`
    );
    const client = createClient();
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: client,
      pipeline,
      startBlock: 101,
      confirmations: 0,
      rangeSize: 1,
      minRangeSize: 1,
      maxRangeSize: 1,
      maxAddressesPerLogRequest: 2,
      marketLogFilterMode: 'topics-only',
    });

    const snapshot = await runner.pollOnce();
    const marketFilters = client.filters.filter((filter) => filter.topics[0] === MARKET_TOPICS);

    assert.equal(marketFilters.length, 1);
    assert.equal(marketFilters[0].address, undefined);
    assert.equal(snapshot.marketLogFilterMode, 'topics-only');
    assert.equal(snapshot.pollers.market.metrics.addressShardedRanges, 0);
    assert.equal(snapshot.pollers.market.metrics.logRequests, 1);
  });

  it('recovers the topics-only market range after a rate-limit shrink despite dense logs', async () => {
    const denseMarketLogs = (filter) => filter.topics[0] === MARKET_TOPICS
      ? Array.from({ length: 11 }, (_, index) => ({
          blockNumber: filter.fromBlock,
          blockHash: `0x${'aa'.repeat(32)}`,
          transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
          logIndex: '0x0',
        }))
      : [];
    const client = createClient({
      heads: ['0x73', '0x73'],
      logs: denseMarketLogs,
      marketFailures: 1,
      marketFailureError: Object.assign(new Error('limited'), { code: 'rate_limited' }),
    });
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: client,
      pipeline: createPipeline(),
      startBlock: 100,
      confirmations: 0,
      rangeSize: 8,
      minRangeSize: 2,
      maxRangeSize: 8,
      maxRangesPerPoll: 3,
      growAfterSuccesses: 2,
      marketLogFilterMode: 'topics-only',
    });

    const snapshot = await runner.pollOnce();

    assert.equal(snapshot.pollers.market.nextBlock, '116');
    assert.equal(snapshot.pollers.market.rangeSize, 8);
    assert.equal(snapshot.pollers.market.metrics.rangeShrinks, 1);
    assert.equal(snapshot.pollers.market.metrics.rangeGrows, 1);
  });

  it('reports HTTP recovery after a failed market cycle without advancing its cursor', async () => {
    const pipeline = createPipeline();
    const client = createClient({ marketFailures: 1 });
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: client,
      pipeline,
      startBlock: 100,
      confirmations: 0,
      rangeSize: 2,
      minRangeSize: 2,
      maxRangeSize: 2,
    });

    await assert.rejects(runner.pollOnce(), /temporary market failure/);
    assert.equal(runner.snapshot().pollers.market.nextBlock, '100');
    const recovered = await runner.pollOnce();
    assert.equal(recovered.runner.errors, 1);
    assert.equal(recovered.runner.recoveries, 1);
    assert.deepEqual(recovered.runner.errorKinds, { 'unknown:Error': 1 });
    assert.equal(recovered.runner.lastError.message, 'temporary market failure');
    assert.equal(recovered.transport.reconnectApplicable, false);
    assert.equal(recovered.coverage.caughtUp, true);
  });

  it('resumes independent persisted cursors and commits empty discovery and market ranges', async () => {
    const pipeline = createPipeline();
    pipeline.processDiscoveryRange = async () => [];
    pipeline.processMarketRange = async () => [];
    const commits = [];
    const repository = {
      loadCursor: async (stream) => ({ stream, next_block: stream === 'discovery' ? '100' : '101' }),
      listActivePools: async () => [],
      commitDiscoveryRange: async (range) => commits.push({ stream: 'discovery', ...range }),
      commitMarketRange: async (range) => commits.push({ stream: 'market', ...range }),
    };
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient(),
      pipeline,
      repository,
      confirmations: 0,
      rangeSize: 10,
      minRangeSize: 10,
      maxRangeSize: 10,
    });

    const snapshot = await runner.pollOnce();
    assert.equal(snapshot.mode, 'continuous-persistent');
    assert.deepEqual(snapshot.coverageStartBlocks, { discovery: '100', market: '101' });
    assert.equal(snapshot.coverageStartBlock, null);
    assert.deepEqual(commits.map((entry) => [entry.stream, entry.cursor.nextBlock]), [
      ['discovery', '102'],
      ['market', '102'],
    ]);
    assert.equal(commits.every((entry) => entry.entries.length === 0), true);
  });

  it('applies independent discovery and market range quotas in one sequential cycle', async () => {
    const repository = {
      loadCursor: async (stream) => ({
        stream,
        next_block: stream === 'discovery' ? '10' : '0',
      }),
      listActivePools: async () => [],
      commitDiscoveryRange: async () => {},
      commitMarketRange: async () => {},
    };
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient({ heads: ['0x64', '0x64'] }),
      pipeline: createPipeline(),
      repository,
      confirmations: 0,
      rangeSize: 1,
      minRangeSize: 1,
      maxRangeSize: 1,
      maxRangesPerPoll: 20,
      discoveryMaxRangesPerPoll: 2,
      marketMaxRangesPerPoll: 3,
    });

    const snapshot = await runner.pollOnce();

    assert.equal(snapshot.pollers.discovery.nextBlock, '12');
    assert.equal(snapshot.pollers.discovery.metrics.ranges, 2);
    assert.equal(snapshot.pollers.market.nextBlock, '3');
    assert.equal(snapshot.pollers.market.metrics.ranges, 3);
  });

  it('disables rollback retention and analytical windows for its persistent pipeline', async () => {
    const repository = {
      loadCursor: async (stream) => ({ stream, next_block: '101' }),
      listActivePools: async () => [],
      commitDiscoveryRange: async () => {},
      commitMarketRange: async () => {},
    };
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient(),
      repository,
      confirmations: 0,
      rangeSize: 1,
      minRangeSize: 1,
      maxRangeSize: 1,
    });

    const snapshot = await runner.pollOnce();

    assert.deepEqual(snapshot.pipeline.inMemoryState, {
      rollbackEnabled: false,
      rollbackLimit: 0,
      observations: 0,
      discoveries: 0,
      windowAggregationEnabled: false,
      windowEvents: 0,
    });
    assert.deepEqual(snapshot.pipeline.windows, []);
  });

  it('fails closed when a persisted checkpoint no longer matches the chain', async () => {
    const checkpointHash = `0x${'aa'.repeat(32)}`;
    const repository = {
      loadCursor: async (stream) => stream === 'discovery' ? {
        next_block: '101',
        checkpoint_block: '100',
        checkpoint_hash: checkpointHash,
      } : null,
      listActivePools: async () => [],
      commitDiscoveryRange: async () => {},
      commitMarketRange: async () => {},
    };
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient(),
      pipeline: createPipeline(),
      repository,
      confirmations: 0,
    });

    await assert.rejects(runner.pollOnce(), (error) => error.code === 'persistent_reorg');
    assert.equal(runner.snapshot().pollers.discovery.nextBlock, '101');
  });

  it('requires an explicit bootstrap boundary until both persistent cursors exist', async () => {
    const repository = {
      loadCursor: async () => null,
      listActivePools: async () => [],
      commitDiscoveryRange: async () => {},
      commitMarketRange: async () => {},
    };

    await assert.rejects(createRobinhoodContinuousRunner({
      rpcClient: createClient(),
      pipeline: createPipeline(),
      repository,
      requireExplicitBootstrap: true,
      confirmations: 0,
    }), (error) => error.code === 'bootstrap_start_required');
  });

  it('caps the market safe head at the completed discovery frontier', async () => {
    const client = createClient({ heads: ['0x65', '0x69'], blockTimestamp: '0x3e8' });
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: client,
      pipeline: createPipeline(),
      startBlock: 100,
      confirmations: 0,
      rangeSize: 10,
      minRangeSize: 10,
      maxRangeSize: 10,
      now: () => 1_001_000,
    });
    const snapshot = await runner.pollOnce();
    const discoveryFilter = client.filters.find((filter) => filter.topics[0] === DISCOVERY_TOPICS);
    const marketFilter = client.filters.find((filter) => filter.topics[0] === MARKET_TOPICS);

    assert.equal(discoveryFilter.toBlock, '0x69');
    assert.equal(marketFilter.toBlock, discoveryFilter.toBlock);
    assert.equal(snapshot.coverage.discoverySafeHead, '105');
    assert.equal(snapshot.coverage.marketSafeHead, '105');
    assert.equal(snapshot.coverage.headProcessingDelayMs, 1000);
    assert.equal(BigInt(snapshot.coverage.marketCursor) <= BigInt(snapshot.coverage.discoveryCursor), true);
  });

  it('reports provider bytes, errors, fallbacks and 429s without endpoint data', async () => {
    const metrics = {
      'robinhood-public': {
        eth_getLogs: {
          requests: 3,
          errors: 1,
          fallbacks: 0,
          requestBytes: 100,
          responseBytes: 200,
          statuses: { '429': 1 },
        },
      },
      'alchemy-free': {
        eth_getLogs: {
          requests: 1,
          errors: 0,
          fallbacks: 1,
          requestBytes: 50,
          responseBytes: 75,
          statuses: { '429': 0 },
        },
      },
    };

    assert.deepEqual(summarizeRpcMetrics(metrics), {
      'robinhood-public': {
        requests: 3, errors: 1, fallbacks: 0, requestBytes: 100, responseBytes: 200, rateLimited: 1,
        errorCodes: {},
      },
      'alchemy-free': {
        requests: 1, errors: 0, fallbacks: 1, requestBytes: 50, responseBytes: 75, rateLimited: 0,
        errorCodes: {},
      },
    });
  });

  it('exposes whether Alchemy is enabled and keeps NOXA comparison non-authoritative', async () => {
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient({ providers: ['robinhood-public', 'alchemy-free'] }),
      pipeline: createPipeline(),
      startBlock: 101,
      confirmations: 0,
    });
    const snapshot = runner.snapshot();

    assert.equal(snapshot.alchemyEnabled, true);
    assert.equal(snapshot.noxaComparison.status, 'not_automated');
    assert.equal(snapshot.noxaComparison.reason, 'no_public_versioned_indexer_api_contract');
    assert.equal(snapshot.noxaComparison.samples, 0);
  });

  it('runs for a bounded duration and emits periodic reports', async () => {
    let now = 1000;
    const reports = [];
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient(),
      pipeline: createPipeline(),
      startBlock: 101,
      confirmations: 0,
      now: () => now,
      sleep: async (delayMs) => { now += delayMs; },
    });
    const snapshot = await runner.runFor(100, {
      intervalMs: 20,
      reportIntervalMs: 40,
      onReport: (report) => reports.push(report),
    });

    assert.equal(snapshot.durationMs, 100);
    assert.equal(snapshot.runner.cycles, 5);
    assert.equal(reports.length, 2);
  });

  it('starts low-priority social metadata draining without blocking the onchain cycle', async () => {
    let drains = 0;
    const socialMetadataQueue = { drainOnce: () => { drains += 1; return new Promise(() => {}); } };
    const runner = await createRobinhoodContinuousRunner({
      rpcClient: createClient(),
      pipeline: createPipeline(),
      socialMetadataQueue,
      startBlock: 101,
      confirmations: 0,
    });

    await runner.pollOnce();
    assert.equal(drains, 1);
  });
});
