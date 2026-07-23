const { createErc20MetadataReader } = require('./evm-erc20-metadata');
const { createErc20SupplyDeltaReader } = require('./evm-erc20-supply-delta');
const { createBlockTimestampEnricher, mapWithConcurrency } = require('./evm-log-enrichment');
const { createEvmMarketWindowAggregator, eventIdentity } = require('./evm-market-window-aggregator');
const { buildMarketObservation, ROBINHOOD_WETH } = require('./evm-market-metrics');
const {
  buildLiquidityAssessment,
  classifyTokenEligibility,
} = require('./robinhood-market-policy');
const { createRobinhoodWethUsdQuoteReader } = require('./robinhood-weth-usd-quote');
const { createNoxaLaunchValidator } = require('./noxa-launch-validator');
const noxa = require('./noxa-launch-decoder');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');

const DEFAULT_ROLLBACK_STATE_LIMIT = 10000;

function createProtocolStats() {
  return { logs: 0, discoveries: 0, swapsDecoded: 0, swapsAccepted: 0, swapsRejected: 0 };
}

function createMetrics() {
  return {
    logsSeen: 0,
    logsIgnored: 0,
    discoveries: 0,
    swapsDecoded: 0,
    swapsAccepted: 0,
    swapsRejected: 0,
    missingQuote: 0,
    metadataRejected: 0,
    eligibilityRejected: 0,
    observationsRemoved: 0,
    discoveriesRemoved: 0,
    socialMetadataQueued: 0,
    socialMetadataQueueErrors: 0,
    v2ReserveDepleted: 0,
    noxa: { seen: 0, accepted: 0, rejected: 0 },
    errors: 0,
    delaySamplesMs: [],
    protocols: {
      'uniswap-v2': createProtocolStats(),
      'uniswap-v3': createProtocolStats(),
      'uniswap-v4': createProtocolStats(),
    },
  };
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1];
}

function numericQuantity(value) {
  return BigInt(String(value || '0'));
}

function blockTag(value) {
  return `0x${numericQuantity(value).toString(16)}`;
}

function metadataWithSupply(metadata, supplyRaw, status, sourceBlockTag) {
  return {
    ...metadata,
    totalSupplyRaw: supplyRaw == null ? null : String(supplyRaw),
    usable: metadata?.decimals != null && supplyRaw != null,
    tokenSupplyStatus: status,
    tokenSupplyBlockTag: sourceBlockTag,
  };
}

function sortLogs(logs) {
  return [...logs].sort((left, right) => {
    const blockDifference = numericQuantity(left.blockNumber) - numericQuantity(right.blockNumber);
    return blockDifference === 0n
      ? Number(numericQuantity(left.logIndex) - numericQuantity(right.logIndex))
      : Number(blockDifference);
  });
}

function rate(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
}

function rollbackStateLimit(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 1_000_000)) : DEFAULT_ROLLBACK_STATE_LIMIT;
}

function rememberRollbackEntry(store, key, value, limit) {
  if (!store || !key) return;
  store.set(key, value);
  while (store.size > limit) store.delete(store.keys().next().value);
}

function supplyDeltaReaderFor(options, rpcClient) {
  return options.supplyDeltaReader || createErc20SupplyDeltaReader({ rpcClient });
}

function cacheEntryLimit(value, fallback = 5000) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function persistedPoolSeeds(rows = []) {
  const seeds = { v2: [], v3: [], v4: [] };
  for (const row of rows) {
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    const common = {
      protocol: row.protocol,
      marketKey: row.market_key,
      tokenAddress: row.token_address,
      quoteAddress: row.quote_address,
      quoteIndex: Number(metadata.quoteIndex),
      token0: row.currency0,
      token1: row.currency1,
      currency0: row.currency0,
      currency1: row.currency1,
      fee: row.fee == null ? null : Number(row.fee),
      tickSpacing: row.tick_spacing == null ? null : Number(row.tick_spacing),
    };
    if (row.protocol === 'uniswap-v2') seeds.v2.push({ ...common, pairAddress: row.pool_address });
    if (row.protocol === 'uniswap-v3') seeds.v3.push({ ...common, poolAddress: row.pool_address });
    if (row.protocol === 'uniswap-v4') {
      seeds.v4.push({
        ...common,
        poolId: row.pool_id,
        poolManagerAddress: row.origin_address || v4.ROBINHOOD_V4_POOL_MANAGER,
        quoteCurrencyAddress: Number(metadata.quoteIndex) === 0 ? row.currency0 : row.currency1,
        quoteKind: metadata.quoteKind,
      });
    }
  }
  return seeds;
}

function createRobinhoodOnchainPipeline(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const rpcClient = options.rpcClient;
  const now = options.now || Date.now;
  const metadataReader = options.metadataReader || createErc20MetadataReader({ rpcClient });
  const supplyDeltaReader = supplyDeltaReaderFor(options, rpcClient);
  const quoteReader = options.quoteReader || createRobinhoodWethUsdQuoteReader({ rpcClient });
  const windowAggregationEnabled = options.windowAggregationEnabled !== false;
  const aggregator = windowAggregationEnabled
    ? (options.aggregator || createEvmMarketWindowAggregator())
    : null;
  const rollbackEnabled = options.retainRollbackState !== false;
  const rollbackLimit = rollbackStateLimit(options.rollbackStateLimit);
  const poolSeeds = persistedPoolSeeds(options.seedPools);
  const v2Tracker = options.v2Tracker || v2.createUniswapV2Tracker({ seedPairs: poolSeeds.v2 });
  const v3Tracker = options.v3Tracker || v3.createUniswapV3Tracker({ seedPools: poolSeeds.v3 });
  const v4Tracker = options.v4Tracker || v4.createUniswapV4Tracker({ seedPools: poolSeeds.v4 });
  const timestampEnricher = options.timestampEnricher || createBlockTimestampEnricher({
    rpcClient,
    concurrency: options.timestampConcurrency,
    batchSize: options.timestampBatchSize,
  });
  const observationConcurrency = Math.max(1, Number(options.observationConcurrency) || 1);
  const socialMetadataQueue = options.socialMetadataQueue || null;
  const noxaValidator = options.noxaValidator || createNoxaLaunchValidator({ rpcClient });
  const observations = rollbackEnabled ? new Map() : null;
  const discoveries = rollbackEnabled ? new Map() : null;
  const metrics = createMetrics();
  const wethQuoteCache = new Map();
  const wethQuotePending = new Map();
  const wethQuoteCacheLimit = cacheEntryLimit(options.wethQuoteCacheEntries);
  const supplyCheckpoints = new Map();
  const supplyResolutionPending = new Map();

  function seed(seedLogs = {}) {
    for (const log of seedLogs.v2 || []) enqueueSocialMetadata(v2Tracker.processLog(log));
    for (const log of seedLogs.v3 || []) enqueueSocialMetadata(v3Tracker.processLog(log));
    for (const log of seedLogs.v4 || []) enqueueSocialMetadata(v4Tracker.processLog(log));
  }

  function enqueueSocialMetadata(event) {
    if (!socialMetadataQueue || (!event?.tracked && !event?.accepted) || !event.tokenAddress) return;
    try {
      if (socialMetadataQueue.enqueue(event.tokenAddress)) metrics.socialMetadataQueued += 1;
    } catch (_) {
      metrics.socialMetadataQueueErrors += 1;
    }
  }

  function recordEvent(event) {
    if (!event?.protocol || !metrics.protocols[event.protocol]) return;
    const stats = metrics.protocols[event.protocol];
    stats.logs += 1;
    if (event.kind === 'pair-created' || event.kind === 'pool-created' || event.kind === 'initialize') {
      stats.discoveries += 1;
      metrics.discoveries += 1;
    }
  }

  function decodeDiscovery(log) {
    const emitter = String(log.address || '').toLowerCase();
    if (emitter === v2.ROBINHOOD_V2_FACTORY) return v2Tracker.processLog(log);
    if (emitter === v3.ROBINHOOD_V3_FACTORY) return v3Tracker.processLog(log);
    if (emitter === v4.ROBINHOOD_V4_POOL_MANAGER) return v4Tracker.processLog(log);
    return { kind: 'ignored', reason: 'unknown_discovery_emitter' };
  }

  function decodeMarket(log) {
    const emitter = String(log.address || '').toLowerCase();
    if (emitter === v4.ROBINHOOD_V4_POOL_MANAGER) return v4Tracker.processLog(log);
    if (v2Tracker.getPair(emitter)) return v2Tracker.processLog(log);
    if (v3Tracker.getPool(emitter)) return v3Tracker.processLog(log);
    return { kind: 'ignored', reason: 'unknown_market_emitter' };
  }

  function isTrackedMarketEmitter(log) {
    const emitter = String(log?.address || '').toLowerCase();
    return emitter === v4.ROBINHOOD_V4_POOL_MANAGER
      || Boolean(v2Tracker.getPair(emitter))
      || Boolean(v3Tracker.getPool(emitter));
  }

  async function getWethQuote(blockNumber) {
    const resolvedBlockTag = blockTag(blockNumber);
    if (wethQuoteCache.has(resolvedBlockTag)) return wethQuoteCache.get(resolvedBlockTag);
    if (wethQuotePending.has(resolvedBlockTag)) return wethQuotePending.get(resolvedBlockTag);
    const task = quoteReader.getSnapshot({ blockTag: resolvedBlockTag }).then((quote) => {
      wethQuoteCache.set(resolvedBlockTag, quote);
      while (wethQuoteCache.size > wethQuoteCacheLimit) {
        wethQuoteCache.delete(wethQuoteCache.keys().next().value);
      }
      return quote;
    }).finally(() => wethQuotePending.delete(resolvedBlockTag));
    wethQuotePending.set(resolvedBlockTag, task);
    return task;
  }

  function rejectionMetric(reason) {
    if (reason === 'quote_usd_unavailable') metrics.missingQuote += 1;
    if (String(reason).includes('metadata')) metrics.metadataRejected += 1;
    if (reason === 'eligibility_not_checked' || reason === 'token_ineligible') metrics.eligibilityRejected += 1;
    if (reason === 'v2_token_reserve_depleted') metrics.v2ReserveDepleted += 1;
  }

  function rememberSupplyCheckpoint(address, resolvedBlockTag, totalSupplyRaw) {
    const key = String(address).toLowerCase();
    const blockNumber = numericQuantity(resolvedBlockTag);
    const current = supplyCheckpoints.get(key);
    if (!current || blockNumber >= current.blockNumber) {
      supplyCheckpoints.set(key, {
        blockNumber,
        blockTag: resolvedBlockTag,
        totalSupplyRaw: String(totalSupplyRaw),
      });
    }
  }

  async function reconstructSupplyBetweenAnchors(address, checkpoint, targetBlock) {
    if (typeof metadataReader.getTotalSupply !== 'function') return null;
    const nextBlock = targetBlock + 1n;
    const [toTarget, afterTarget, nextAnchor] = await Promise.all([
      supplyDeltaReader.getDelta(address, {
        fromBlock: checkpoint.blockNumber + 1n,
        toBlock: targetBlock,
      }),
      supplyDeltaReader.getDelta(address, { fromBlock: nextBlock, toBlock: nextBlock }),
      metadataReader.getTotalSupply(address, { blockTag: blockTag(nextBlock) }),
    ]);
    if (!toTarget?.usable || !afterTarget?.usable || !nextAnchor?.usable) return null;
    const reconstructed = BigInt(checkpoint.totalSupplyRaw) + BigInt(toTarget.deltaRaw);
    const expectedNext = reconstructed + BigInt(afterTarget.deltaRaw);
    if (reconstructed < 0n || expectedNext !== BigInt(nextAnchor.totalSupplyRaw)) return null;
    return {
      totalSupplyRaw: reconstructed,
      status: BigInt(toTarget.deltaRaw) === 0n
        ? 'unchanged_between_anchors'
        : 'reconstructed_mint_burn',
    };
  }

  async function resolveTokenMetadata(address, blockNumber) {
    const resolvedBlockTag = blockTag(blockNumber);
    let identity;
    let historical;
    if (typeof metadataReader.getTotalSupply === 'function') {
      [identity, historical] = await Promise.all([
        metadataReader.getMetadata(address),
        metadataReader.getTotalSupply(address, { blockTag: resolvedBlockTag }),
      ]);
      if (historical?.usable) {
        rememberSupplyCheckpoint(address, resolvedBlockTag, historical.totalSupplyRaw);
        return metadataWithSupply(
          identity,
          historical.totalSupplyRaw,
          'exact_block_call',
          resolvedBlockTag
        );
      }
    } else {
      historical = await metadataReader.getMetadata(address, { blockTag: resolvedBlockTag });
      if (historical?.usable) {
        rememberSupplyCheckpoint(address, resolvedBlockTag, historical.totalSupplyRaw);
        return metadataWithSupply(
          historical,
          historical.totalSupplyRaw,
          'exact_block_call',
          resolvedBlockTag
        );
      }
      identity = await metadataReader.getMetadata(address);
    }
    const checkpoint = supplyCheckpoints.get(String(address).toLowerCase());
    const targetBlock = numericQuantity(resolvedBlockTag);
    if (checkpoint && checkpoint.blockNumber <= targetBlock) {
      const reconstructed = await reconstructSupplyBetweenAnchors(address, checkpoint, targetBlock);
      if (reconstructed) {
        rememberSupplyCheckpoint(address, resolvedBlockTag, reconstructed.totalSupplyRaw);
        return metadataWithSupply(
          identity || historical,
          reconstructed.totalSupplyRaw,
          reconstructed.status,
          checkpoint.blockTag
        );
      }
    }
    return metadataWithSupply(
      identity || historical,
      null,
      'unavailable',
      null
    );
  }

  function resolveTokenMetadataInOrder(address, blockNumber) {
    const key = String(address).toLowerCase();
    const previous = supplyResolutionPending.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => resolveTokenMetadata(address, blockNumber));
    supplyResolutionPending.set(key, task);
    return task.finally(() => {
      if (supplyResolutionPending.get(key) === task) supplyResolutionPending.delete(key);
    });
  }

  async function buildObservation(swap) {
    const eligibility = classifyTokenEligibility(swap.tokenAddress, options.policyOptions);
    const [tokenMetadata, quoteMetadata] = await Promise.all([
      resolveTokenMetadataInOrder(swap.tokenAddress, swap.blockNumber),
      metadataReader.getMetadata(swap.quoteAddress),
    ]);
    let quoteOptions = null;
    if (swap.quoteAddress === ROBINHOOD_WETH) {
      try {
        quoteOptions = await getWethQuote(swap.blockNumber);
      } catch (error) {
        if (error?.retryable === true) throw error;
        quoteOptions = null;
      }
    }
    const observation = buildMarketObservation({
      swap,
      tokenMetadata,
      quoteMetadata,
      eligibility,
      ...(quoteOptions ? {
        wethUsdPrice: quoteOptions.priceUsd,
        wethUsdSource: quoteOptions.source,
      } : {}),
    });
    if (!observation.accepted) return observation;
    const liquidity = buildLiquidityAssessment({
      protocol: swap.protocol,
      quoteReserveRaw: swap.quoteReserveRaw,
      quoteDecimals: quoteMetadata.decimals,
      quoteUsdPrice: observation.quoteUsdPrice,
      liquidityRaw: swap.liquidityRaw,
    });
    return {
      ...observation,
      liquidityUsd: liquidity.liquidityUsd,
      liquidityRaw: liquidity.liquidityRaw ?? null,
      liquidityStatus: liquidity.status,
      liquidityConfidence: liquidity.confidence,
      liquidityWarning: liquidity.warning ?? null,
    };
  }

  function recordDelay(observation) {
    const delay = Math.max(0, now() - Number(observation.timestampMs));
    metrics.delaySamplesMs.push(delay);
    if (metrics.delaySamplesMs.length > 256) metrics.delaySamplesMs.shift();
  }

  async function processDiscoveryBatch(logs) {
    let entries;
    let enrichedLogs;
    try {
      enrichedLogs = await timestampEnricher.enrich(sortLogs(logs));
    } catch (error) {
      metrics.errors += 1;
      throw error;
    }
    entries = new Array(enrichedLogs.length);
    const noxaLogs = [];
    for (let index = 0; index < enrichedLogs.length; index += 1) {
      const rawLog = enrichedLogs[index];
      metrics.logsSeen += 1;
      if (String(rawLog.address || '').toLowerCase() === noxa.NOXA_FACTORY) {
        noxaLogs.push({ index, rawLog });
        continue;
      }
      try {
        const event = decodeDiscovery(rawLog);
        entries[index] = { log: rawLog, event };
        if (event.kind === 'ignored') metrics.logsIgnored += 1;
        else {
          recordEvent(event);
          enqueueSocialMetadata(event);
          rememberRollbackEntry(
            discoveries,
            eventIdentity({ chain: 'robinhood', ...rawLog }),
            event,
            rollbackLimit
          );
        }
      } catch (_) {
        metrics.errors += 1;
        throw _;
      }
    }
    for (const { index, rawLog } of noxaLogs) {
      metrics.noxa.seen += 1;
      try {
        const launch = noxa.decodeTokenLaunched(rawLog);
        const validation = await noxaValidator.validateOnchain(launch, {
          blockTag: rawLog.blockNumber,
          v3Pool: v3Tracker.getPool(launch.poolAddress),
        });
        const event = validation.accepted ? {
          ...validation,
          protocol: 'uniswap-v3',
          marketKey: validation.marketDiscoveryKey,
        } : validation;
        entries[index] = { log: rawLog, event };
        if (event.accepted) {
          metrics.noxa.accepted += 1;
          enqueueSocialMetadata(event);
        } else {
          metrics.noxa.rejected += 1;
        }
        rememberRollbackEntry(
          discoveries,
          eventIdentity({ chain: 'robinhood', ...rawLog }),
          event,
          rollbackLimit
        );
      } catch (error) {
        metrics.errors += 1;
        throw error;
      }
    }
    return entries;
  }

  async function processDiscoveryLogs(logs) {
    await processDiscoveryBatch(logs);
  }

  async function processMarketBatch(logs) {
    const accepted = [];
    const entries = [];
    let enrichedLogs;
    try {
      const trackedLogs = [];
      for (const log of sortLogs(logs)) {
        metrics.logsSeen += 1;
        if (isTrackedMarketEmitter(log)) trackedLogs.push(log);
        else metrics.logsIgnored += 1;
      }
      enrichedLogs = await timestampEnricher.enrich(trackedLogs);
    } catch (error) {
      metrics.errors += 1;
      throw error;
    }
    const swaps = [];
    for (const rawLog of enrichedLogs) {
      try {
        const event = decodeMarket(rawLog);
        if (event.kind !== 'swap') {
          if (event.kind === 'ignored') {
            metrics.logsIgnored += 1;
            continue;
          }
          entries.push({ log: rawLog, event });
          recordEvent(event);
          continue;
        }
        recordEvent(event);
        metrics.swapsDecoded += 1;
        metrics.protocols[event.protocol].swapsDecoded += 1;
        swaps.push({ event, log: rawLog });
      } catch (error) {
        metrics.errors += 1;
        throw error;
      }
    }
    let observationsForBatch;
    try {
      observationsForBatch = await mapWithConcurrency(
        swaps,
        observationConcurrency,
        ({ event }) => buildObservation(event)
      );
    } catch (error) {
      metrics.errors += 1;
      throw error;
    }
    for (let index = 0; index < swaps.length; index += 1) {
      const { event, log } = swaps[index];
      const observation = observationsForBatch[index];
      entries.push({ log, event, observation });
      try {
        if (!observation.accepted) {
          metrics.swapsRejected += 1;
          metrics.protocols[event.protocol].swapsRejected += 1;
          rejectionMetric(observation.reason);
          continue;
        }
        if (aggregator && !aggregator.add(observation, now()).accepted) continue;
        const id = eventIdentity(observation);
        rememberRollbackEntry(observations, id, observation, rollbackLimit);
        metrics.swapsAccepted += 1;
        metrics.protocols[event.protocol].swapsAccepted += 1;
        recordDelay(observation);
        accepted.push(observation);
      } catch (_) {
        metrics.errors += 1;
        throw _;
      }
    }
    return { accepted, entries };
  }

  async function processMarketLogs(logs) {
    return (await processMarketBatch(logs)).accepted;
  }

  function processRemovedLogs(logs) {
    if (!observations) return 0;
    let removed = 0;
    for (const log of logs) {
      const id = eventIdentity({ chain: 'robinhood', ...log });
      const observation = observations.get(id);
      if (observation) {
        aggregator?.remove(observation);
        removed += 1;
      }
      observations.delete(id);
    }
    metrics.observationsRemoved += removed;
    return removed;
  }

  function processRemovedDiscoveryLogs(logs) {
    if (!discoveries) return 0;
    let removed = 0;
    for (const log of logs) {
      const id = eventIdentity({ chain: 'robinhood', ...log });
      const event = discoveries.get(id);
      if (event?.kind === 'pair-created') removed += v2Tracker.removePair(event.pairAddress) ? 1 : 0;
      if (event?.kind === 'pool-created') removed += v3Tracker.removePool(event.poolAddress) ? 1 : 0;
      if (event?.kind === 'initialize') removed += v4Tracker.removePool(event.poolId) ? 1 : 0;
      discoveries.delete(id);
    }
    metrics.discoveriesRemoved += removed;
    return removed;
  }

  function getTrackedMarketAddresses() {
    return [
      ...v2Tracker.getTrackedPairs().map((pair) => pair.pairAddress),
      ...v3Tracker.getTrackedPools().map((pool) => pool.poolAddress),
      v4.ROBINHOOD_V4_POOL_MANAGER,
    ];
  }

  function snapshot() {
    const delays = metrics.delaySamplesMs;
    return {
      tracked: {
        v2: v2Tracker.getTrackedPairCount(),
        v3: v3Tracker.getTrackedPoolCount(),
        v4: v4Tracker.getTrackedPoolCount(),
      },
      metrics: {
        ...metrics,
        delaySamplesMs: undefined,
        withoutQuoteRate: rate(metrics.missingQuote, metrics.swapsDecoded),
        processingDelayMs: { count: delays.length, p50: percentile(delays, 50), p95: percentile(delays, 95) },
        noxa: { ...metrics.noxa },
        protocols: Object.fromEntries(Object.entries(metrics.protocols).map(([key, value]) => [key, { ...value }])),
      },
      enrichment: {
        timestamps: timestampEnricher.snapshot(),
        observationConcurrency,
        supplyCheckpoints: supplyCheckpoints.size,
        wethQuoteBlocks: wethQuoteCache.size,
      },
      socialMetadata: socialMetadataQueue?.snapshot?.() || { enabled: false },
      inMemoryState: {
        rollbackEnabled,
        rollbackLimit: rollbackEnabled ? rollbackLimit : 0,
        observations: observations?.size || 0,
        discoveries: discoveries?.size || 0,
        windowAggregationEnabled,
        windowEvents: aggregator?.size() || 0,
      },
      windows: aggregator ? aggregator.snapshot(now()) : [],
    };
  }

  seed(options.seedLogs);
  return Object.freeze({
    getTrackedMarketAddresses,
    processDiscoveryRange: processDiscoveryBatch,
    processDiscoveryLogs,
    processMarketRange: async (logs) => (await processMarketBatch(logs)).entries,
    processMarketLogs,
    processRemovedDiscoveryLogs,
    processRemovedLogs,
    snapshot,
  });
}

module.exports = { createRobinhoodOnchainPipeline, sortLogs };
