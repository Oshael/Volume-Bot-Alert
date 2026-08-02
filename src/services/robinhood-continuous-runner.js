const { createEvmLogPoller, parseQuantity } = require('./evm-log-poller');
const { createRobinhoodOnchainPipeline } = require('./robinhood-onchain-pipeline');
const noxa = require('./noxa-launch-decoder');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');

const DISCOVERY_TOPICS = Object.freeze([
  v2.TOPICS.pairCreated,
  v3.TOPICS.poolCreated,
  v4.TOPICS.initialize,
  noxa.TOKEN_LAUNCHED_TOPIC,
]);
const DISCOVERY_ADDRESSES = Object.freeze([
  v2.ROBINHOOD_V2_FACTORY,
  v3.ROBINHOOD_V3_FACTORY,
  v4.ROBINHOOD_V4_POOL_MANAGER,
  noxa.NOXA_FACTORY,
]);
const BOOTSTRAP_DISCOVERY_TOPICS = Object.freeze(DISCOVERY_TOPICS.slice(0, 3));
const BOOTSTRAP_DISCOVERY_ADDRESSES = Object.freeze(DISCOVERY_ADDRESSES.slice(0, 3));
const MARKET_TOPICS = Object.freeze([
  v2.TOPICS.swap,
  v2.TOPICS.sync,
  v3.TOPICS.initialize,
  v3.TOPICS.swap,
  v4.TOPICS.modifyLiquidity,
  v4.TOPICS.swap,
]);

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function summarizeRpcMetrics(metrics) {
  const summary = {};
  for (const [provider, methods] of Object.entries(metrics || {})) {
    const output = {
      requests: 0, errors: 0, fallbacks: 0, requestBytes: 0, responseBytes: 0, rateLimited: 0, errorCodes: {},
    };
    for (const value of Object.values(methods)) {
      output.requests += value.requests || 0;
      output.errors += value.errors || 0;
      output.fallbacks += value.fallbacks || 0;
      output.requestBytes += value.requestBytes || 0;
      output.responseBytes += value.responseBytes || 0;
      output.rateLimited += value.statuses?.['429'] || 0;
      for (const [code, count] of Object.entries(value.errorCodes || {})) {
        output.errorCodes[code] = (output.errorCodes[code] || 0) + count;
      }
    }
    summary[provider] = output;
  }
  return summary;
}

function coverageStatus(discovery, market, nowMs) {
  const caughtUp = discovery.lagBlocks === 0 && market.lagBlocks === 0;
  const checkpointTimestamp = Number(discovery.checkpoint?.timestampMs);
  return {
    status: caughtUp ? 'complete_within_declared_range' : 'backfilling',
    caughtUp,
    unexplainedGaps: 0,
    discoveryCursor: discovery.nextBlock,
    marketCursor: market.nextBlock,
    discoverySafeHead: discovery.safeHead,
    marketSafeHead: market.safeHead,
    headProcessingDelayMs: checkpointTimestamp > 0 ? Math.max(0, nowMs - checkpointTimestamp) : null,
  };
}

function cursorNextBlock(cursor) {
  return cursor?.next_block ?? cursor?.nextBlock ?? null;
}

function cursorCheckpoint(cursor) {
  const number = cursor?.checkpoint_block ?? cursor?.checkpointBlock;
  const hash = cursor?.checkpoint_hash ?? cursor?.checkpointHash;
  if (number == null || hash == null) return null;
  const timestamp = cursor?.checkpoint_timestamp ?? cursor?.checkpointTimestamp;
  return {
    number,
    hash,
    timestampMs: timestamp == null
      ? null
      : (timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp)),
  };
}

async function loadRunnerState(rpcClient, repository) {
  const [headValue, discoveryCursor, marketCursor, persistedPools] = await Promise.all([
    rpcClient.request('eth_blockNumber'),
    repository?.loadCursor('discovery') || null,
    repository?.loadCursor('market') || null,
    repository?.listActivePools() || [],
  ]);
  return { headValue, discoveryCursor, marketCursor, persistedPools };
}

function persistentReorg(context) {
  const error = new Error(`Persistent Robinhood reorg requires operator recovery (${context.reason})`);
  error.code = 'persistent_reorg';
  throw error;
}

function streamHandlers(repository, pipeline, stream) {
  const discovery = stream === 'discovery';
  if (!repository) return {
    onLogs: discovery ? pipeline.processDiscoveryLogs : pipeline.processMarketLogs,
    onRemoved: discovery ? pipeline.processRemovedDiscoveryLogs : pipeline.processRemovedLogs,
  };
  const commit = discovery ? repository.commitDiscoveryRange : repository.commitMarketRange;
  return {
    onLogs: discovery
      ? (pipeline.processDiscoveryRange || pipeline.processDiscoveryLogs)
      : (pipeline.processMarketRange || pipeline.processMarketLogs),
    onRange: (range) => commit({ entries: range.consumerResult || [], cursor: range }),
    onRemoved: (_logs, context) => persistentReorg(context),
    onReorg: persistentReorg,
  };
}

function resolveCoverageStart(options, headValue, discoveryCursor, marketCursor) {
  const confirmations = Math.max(0, Number(options.confirmations ?? 2));
  const head = parseQuantity(headValue, 'eth_blockNumber');
  const safeHead = head >= BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
  const lookbackBlocks = BigInt(Math.max(1, Number(options.lookbackBlocks) || 100));
  const fallback = options.startBlock == null
    ? (safeHead >= lookbackBlocks - 1n ? safeHead - lookbackBlocks + 1n : 0n)
    : parseQuantity(options.startBlock, 'startBlock');
  return {
    confirmations,
    discoveryStartBlock: cursorNextBlock(discoveryCursor) ?? fallback,
    marketStartBlock: cursorNextBlock(marketCursor) ?? fallback,
  };
}

function commonPollerOptions(options, rpcClient, confirmations) {
  return {
    client: rpcClient,
    confirmations,
    rangeSize: options.rangeSize || 10,
    minRangeSize: options.minRangeSize || 1,
    maxRangeSize: options.maxRangeSize || 100,
    maxRangesPerPoll: options.maxRangesPerPoll || 20,
    maxAddressesPerRequest: options.maxAddressesPerLogRequest || 100,
    growAfterSuccesses: options.growAfterSuccesses || 3,
    reorgDepth: options.reorgDepth || 12,
  };
}

async function createRobinhoodContinuousRunner(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const rpcClient = options.rpcClient;
  const repository = options.repository || null;
  const { headValue, discoveryCursor, marketCursor, persistedPools } = await loadRunnerState(
    rpcClient,
    repository
  );
  if (
    repository
    && options.requireExplicitBootstrap === true
    && (!discoveryCursor || !marketCursor)
    && options.startBlock == null
  ) {
    const error = new Error('ROBINHOOD_START_BLOCK is required until both persistent cursors exist');
    error.code = 'bootstrap_start_required';
    throw error;
  }
  const { confirmations, discoveryStartBlock, marketStartBlock } = resolveCoverageStart(
    options,
    headValue,
    discoveryCursor,
    marketCursor
  );
  const pipeline = options.pipeline || createRobinhoodOnchainPipeline({
    rpcClient,
    seedLogs: options.seedLogs,
    seedPools: persistedPools,
    now: options.now,
    retainRollbackState: !repository,
    windowAggregationEnabled: !repository,
    timestampConcurrency: options.timestampConcurrency,
    timestampBatchSize: options.timestampBatchSize,
    observationConcurrency: options.observationConcurrency,
    socialMetadataQueue: options.socialMetadataQueue,
  });
  const pollerOptions = commonPollerOptions(options, rpcClient, confirmations);
  const discoveryHandlers = streamHandlers(repository, pipeline, 'discovery');
  const discoveryPoller = createEvmLogPoller({
    ...pollerOptions,
    maxRangesPerPoll: options.discoveryMaxRangesPerPoll ?? pollerOptions.maxRangesPerPoll,
    startBlock: discoveryStartBlock,
    checkpoint: cursorCheckpoint(discoveryCursor),
    filter: {
      address: DISCOVERY_ADDRESSES,
      topics: [DISCOVERY_TOPICS],
    },
    ...discoveryHandlers,
  });
  const marketClient = {
    request: (method, params, requestOptions) => {
      if (method !== 'eth_blockNumber') return rpcClient.request(method, params, requestOptions);
      const discoveryStatus = discoveryPoller.getStatus();
      if (discoveryStatus.nextBlock == null) return rpcClient.request(method, params, requestOptions);
      const completedThrough = BigInt(discoveryStatus.nextBlock) - 1n;
      return Promise.resolve(toQuantity(completedThrough + BigInt(confirmations)));
    },
  };
  const marketHandlers = streamHandlers(repository, pipeline, 'market');
  const marketLogFilterMode = options.marketLogFilterMode === 'topics-only'
    ? 'topics-only'
    : 'tracked-addresses';
  const marketPoller = createEvmLogPoller({
    ...pollerOptions,
    maxRangesPerPoll: options.marketMaxRangesPerPoll ?? pollerOptions.maxRangesPerPoll,
    startBlock: marketStartBlock,
    checkpoint: cursorCheckpoint(marketCursor),
    client: marketClient,
    recoverRangeOnSuccess: marketLogFilterMode === 'topics-only',
    filter: { topics: [MARKET_TOPICS] },
    getFilter: () => (marketLogFilterMode === 'topics-only'
      ? {}
      : { address: pipeline.getTrackedMarketAddresses() }),
    ...marketHandlers,
  });
  const runnerMetrics = {
    cycles: 0, errors: 0, recoveries: 0, consecutiveErrors: 0, errorKinds: {}, lastError: null,
  };
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const startedAtMs = (options.now || Date.now)();

  function snapshot() {
    const discovery = discoveryPoller.getStatus();
    const market = marketPoller.getStatus();
    const currentTime = (options.now || Date.now)();
    return {
      mode: repository ? 'continuous-persistent' : 'continuous-read-only',
      marketLogFilterMode,
      transport: { kind: 'http-polling', reconnectApplicable: false, recoveries: runnerMetrics.recoveries },
      coverageStartBlock: BigInt(discoveryStartBlock) === BigInt(marketStartBlock)
        ? BigInt(discoveryStartBlock).toString()
        : null,
      coverageStartBlocks: {
        discovery: BigInt(discoveryStartBlock).toString(),
        market: BigInt(marketStartBlock).toString(),
      },
      coverage: coverageStatus(discovery, market, currentTime),
      durationMs: currentTime - startedAtMs,
      runner: { ...runnerMetrics },
      pollers: { discovery, market },
      backfill: {
        discoveryBlocks: discovery.metrics.backfillBlocks,
        marketBlocks: market.metrics.backfillBlocks,
        discoveryRanges: discovery.metrics.ranges,
        marketRanges: market.metrics.ranges,
      },
      pipeline: pipeline.snapshot(),
      rpc: summarizeRpcMetrics(rpcClient.getMetrics?.() || {}),
      alchemyEnabled: rpcClient.providers?.includes('alchemy-free') || false,
      drpcEnabled: rpcClient.providers?.includes('drpc') || false,
      rpcProviders: Array.isArray(rpcClient.providers) ? [...rpcClient.providers] : null,
      noxaComparison: options.noxaComparison || {
        status: 'not_automated',
        reason: 'no_public_versioned_indexer_api_contract',
        samples: 0,
      },
    };
  }

  async function pollOnce() {
    runnerMetrics.cycles += 1;
    try {
      await discoveryPoller.pollOnce();
      await marketPoller.pollOnce();
      if (options.socialMetadataQueue?.drainOnce) {
        Promise.resolve(options.socialMetadataQueue.drainOnce()).catch(() => {});
      }
      if (runnerMetrics.consecutiveErrors > 0) runnerMetrics.recoveries += 1;
      runnerMetrics.consecutiveErrors = 0;
      return snapshot();
    } catch (error) {
      runnerMetrics.errors += 1;
      runnerMetrics.consecutiveErrors += 1;
      const errorKind = `${error.method || 'unknown'}:${error.code || error.name || 'error'}`;
      runnerMetrics.errorKinds[errorKind] = (runnerMetrics.errorKinds[errorKind] || 0) + 1;
      runnerMetrics.lastError = {
        kind: errorKind,
        message: String(error.message || 'Unknown runner error').slice(0, 200),
        httpStatus: error.httpStatus ?? null,
      };
      throw error;
    }
  }

  async function runFor(durationMs, runOptions = {}) {
    const duration = Math.max(1, Number(durationMs));
    const intervalMs = Math.max(10, Number(runOptions.intervalMs) || 2000);
    const reportIntervalMs = Math.max(intervalMs, Number(runOptions.reportIntervalMs) || 60000);
    const deadline = (options.now || Date.now)() + duration;
    let nextReport = (options.now || Date.now)() + reportIntervalMs;
    while ((options.now || Date.now)() < deadline) {
      try {
        await pollOnce();
      } catch (error) {
        if (runOptions.onError) runOptions.onError(error, snapshot());
      }
      const currentTime = (options.now || Date.now)();
      if (runOptions.onReport && currentTime >= nextReport) {
        runOptions.onReport(snapshot());
        nextReport = currentTime + reportIntervalMs;
      }
      const remaining = deadline - (options.now || Date.now)();
      if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
    }
    return snapshot();
  }

  return Object.freeze({ pollOnce, runFor, snapshot });
}

async function createRobinhoodDiscoveryBootstrapRunner(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  if (!options.repository) throw new Error('repository is required');
  const rpcClient = options.rpcClient;
  const repository = options.repository;
  const [headValue, discoveryCursor, persistedPools] = await Promise.all([
    rpcClient.request('eth_blockNumber'),
    repository.loadCursor('discovery'),
    repository.listActivePools(),
  ]);
  if (!discoveryCursor && options.startBlock == null) {
    const error = new Error('Discovery bootstrap startBlock is required until its cursor exists');
    error.code = 'bootstrap_start_required';
    throw error;
  }
  const confirmations = Math.max(0, Number(options.confirmations ?? 2));
  const startBlock = cursorNextBlock(discoveryCursor) ?? parseQuantity(
    options.startBlock,
    'startBlock'
  ).toString();
  const pipeline = options.pipeline || createRobinhoodOnchainPipeline({
    rpcClient,
    seedPools: persistedPools,
    now: options.now,
    noxaValidator: options.noxaValidator,
    retainRollbackState: false,
    windowAggregationEnabled: false,
  });
  const handlers = streamHandlers(repository, pipeline, 'discovery');
  const poller = createEvmLogPoller({
    ...commonPollerOptions(options, rpcClient, confirmations),
    startBlock,
    checkpoint: cursorCheckpoint(discoveryCursor),
    filter: {
      address: BOOTSTRAP_DISCOVERY_ADDRESSES,
      topics: [BOOTSTRAP_DISCOVERY_TOPICS],
    },
    ...handlers,
  });
  const initialHead = parseQuantity(headValue, 'eth_blockNumber');

  function snapshot() {
    const status = poller.getStatus();
    const target = status.safeHead == null
      ? (initialHead >= BigInt(confirmations) ? initialHead - BigInt(confirmations) : 0n)
      : BigInt(status.safeHead);
    const nextBlock = status.nextBlock == null ? BigInt(startBlock) : BigInt(status.nextBlock);
    return {
      mode: 'discovery-bootstrap-persistent',
      status: nextBlock > target ? 'caught-up' : 'backfilling',
      coverageStartBlock: String(startBlock),
      targetBlock: target.toString(),
      remainingBlocks: (nextBlock > target ? 0n : target - nextBlock + 1n).toString(),
      poller: status,
      tracked: pipeline.snapshot().tracked,
      rpc: summarizeRpcMetrics(rpcClient.getMetrics?.() || {}),
    };
  }

  async function runBatch() {
    await poller.pollOnce();
    return snapshot();
  }

  return Object.freeze({ runBatch, snapshot });
}

module.exports = {
  BOOTSTRAP_DISCOVERY_ADDRESSES,
  BOOTSTRAP_DISCOVERY_TOPICS,
  DISCOVERY_TOPICS,
  DISCOVERY_ADDRESSES,
  MARKET_TOPICS,
  createRobinhoodContinuousRunner,
  createRobinhoodDiscoveryBootstrapRunner,
  summarizeRpcMetrics,
  toQuantity,
};
