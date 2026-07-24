const { createRobinhoodBackfillCaptureRepository } = require('../models/robinhood-backfill-capture');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { isAdaptiveRangeError, parseQuantity, toQuantity } = require('./evm-log-poller');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');
const CHAIN_ID = 4663n;
const PROVIDERS = Object.freeze({
  public: { name: 'robinhood-public', urlKey: 'publicRpcUrl' },
  drpc: { name: 'drpc', urlKey: 'drpcRpcUrl' },
  alchemy: { name: 'alchemy-free', urlKey: 'alchemyRpcUrl' },
});
const MARKET_TOPICS = Object.freeze([
  v2.TOPICS.swap,
  v2.TOPICS.sync,
  v3.TOPICS.initialize,
  v3.TOPICS.swap,
  v4.TOPICS.swap,
]);
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}
function providerRole(value, fallback, label) {
  const role = String(value || fallback).trim().toLowerCase();
  if (!PROVIDERS[role]) throw new Error(`${label} must be public, drpc or alchemy`);
  return role;
}
function normalizeOptions(input = {}) {
  const scanProvider = providerRole(input.scanProvider, 'drpc', 'scanProvider');
  const rangeSize = boundedInteger(input.rangeSize, 10_000, 1, 10_000);
  const maxLogsPerRange = boundedInteger(input.maxLogsPerRange, 10_000, 1, 1_000_000);
  if (scanProvider === 'alchemy' && rangeSize > 10) {
    throw new Error('Alchemy Free scan ranges cannot exceed 10 blocks');
  }
  const startBlock = input.startBlock == null || input.startBlock === ''
    ? null
    : parseQuantity(input.startBlock, 'startBlock').toString();
  return {
    enabled: input.enabled === true,
    scanProvider,
    headProvider: providerRole(input.headProvider, 'public', 'headProvider'),
    publicRpcUrl: String(
      input.publicRpcUrl || 'https://rpc.mainnet.chain.robinhood.com'
    ).trim(),
    drpcRpcUrl: String(input.drpcRpcUrl || '').trim(),
    alchemyRpcUrl: String(input.alchemyRpcUrl || '').trim(),
    startBlock,
    rangeSize,
    minRangeSize: boundedInteger(input.minRangeSize, 10, 1, rangeSize),
    inFlightRanges: boundedInteger(input.inFlightRanges, 1, 1, 8),
    maxLogsPerRange,
    maxBufferedLogs: boundedInteger(
      input.maxBufferedLogs, 50_000, maxLogsPerRange, 1_000_000
    ),
    maxPendingLogs: boundedInteger(input.maxPendingLogs, 250_000, 1, 10_000_000),
    confirmations: boundedInteger(input.confirmations, 2, 0, 1000),
    intervalMs: boundedInteger(input.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(input.maxErrorBackoffMs, 30_000, 1000, 300_000),
    rpcTimeoutMs: boundedInteger(input.rpcTimeoutMs, 15_000, 1000, 60_000),
    rpcMaxRetries: boundedInteger(input.rpcMaxRetries, 1, 0, 5),
    rpcMinIntervalMs: boundedInteger(input.rpcMinIntervalMs, 0, 0, 60_000),
    decoderVersion: String(input.decoderVersion || 'market-log-v1').trim(),
  };
}
function createClient(options, clientFactory = createEvmJsonRpcClient) {
  const roles = [...new Set([options.headProvider, options.scanProvider])];
  const providers = roles.map((role) => {
    const spec = PROVIDERS[role];
    const url = options[spec.urlKey];
    if (!url) throw new Error(`${spec.urlKey} is required for the ${role} provider`);
    return { name: spec.name, url, minRequestIntervalMs: options.rpcMinIntervalMs };
  });
  return clientFactory({
    providers,
    timeoutMs: options.rpcTimeoutMs,
    maxRetries: options.rpcMaxRetries,
    minRequestIntervalMs: options.rpcMinIntervalMs,
  });
}
function roleName(role) {
  return PROVIDERS[role].name;
}
function selectTrackedLogs(logs, pools = []) {
  const addresses = new Map();
  const poolIds = new Map();
  for (const pool of pools) {
    const value = {
      protocol: String(pool.protocol),
      marketKey: String(pool.market_key || pool.marketKey),
    };
    if (pool.pool_address || pool.poolAddress) {
      addresses.set(String(pool.pool_address || pool.poolAddress).toLowerCase(), value);
    }
    if (pool.pool_id || pool.poolId) {
      poolIds.set(String(pool.pool_id || pool.poolId).toLowerCase(), value);
    }
  }
  return logs.flatMap((log) => {
    const address = String(log?.address || '').toLowerCase();
    const pool = address === v4.ROBINHOOD_V4_POOL_MANAGER
      ? poolIds.get(String(log?.topics?.[1] || '').toLowerCase())
      : addresses.get(address);
    return pool ? [{ ...log, protocol: pool.protocol, marketKey: pool.marketKey }] : [];
  });
}
function checkpointFromBlock(block, expectedNumber) {
  const number = parseQuantity(block?.number, 'checkpoint.number');
  const timestamp = parseQuantity(block?.timestamp, 'checkpoint.timestamp');
  if (number !== expectedNumber) throw new Error('Checkpoint block does not match range end');
  const timestampMs = Number(timestamp * 1000n);
  if (!Number.isSafeInteger(timestampMs)) throw new Error('Checkpoint timestamp is unsafe');
  return {
    hash: String(block?.hash || ''),
    timestamp: new Date(timestampMs).toISOString(),
  };
}
function earlierBlock(left, right) {
  return left < right ? left : right;
}
function createRobinhoodBackfillMarketScanner(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  let options = normalizeOptions();
  let client = null;
  let captureRepository = null;
  let catalogRepository = null;
  let providersValidated = false;
  let activeRun = null;
  let timer = null;
  let running = false;
  const status = {
    enabled: false,
    running: false,
    inFlight: false,
    scanProvider: 'drpc',
    headProvider: 'public',
    currentRange: null,
    lastRange: null,
    lastError: null,
    consecutiveErrors: 0,
    totals: {
      ranges: 0, blocks: 0, rawLogs: 0, trackedLogs: 0,
      rangeSplits: 0, backpressurePauses: 0, errors: 0,
    },
    rpc: {},
  };
  function ensureDependencies() {
    client ||= (deps.clientFactory || createClient)(options);
    captureRepository ||= (deps.captureRepositoryFactory
      || createRobinhoodBackfillCaptureRepository)();
    catalogRepository ||= (deps.catalogRepositoryFactory
      || createRobinhoodPersistenceRepository)();
  }
  async function validateProviders() {
    if (providersValidated) return;
    for (const provider of new Set([
      roleName(options.headProvider),
      roleName(options.scanProvider),
    ])) {
      const chainId = parseQuantity(
        await client.requestProvider(provider, 'eth_chainId'),
        `${provider}.chainId`
      );
      if (chainId !== CHAIN_ID) throw new Error(`${provider} is not Robinhood Chain`);
    }
    providersValidated = true;
  }
  function canSplitRange(error, fromBlock, toBlock) {
    return isAdaptiveRangeError(error)
      && error?.code !== 'rate_limited'
      && error?.httpStatus !== 429
      && toBlock - fromBlock + 1n > BigInt(options.minRangeSize);
  }
  async function scanBatch() {
    ensureDependencies();
    const backlog = await captureRepository.getBacklogSummary();
    const openLogs = backlog.pending + backlog.leased + backlog.blocked;
    if (openLogs >= options.maxPendingLogs) {
      status.totals.backpressurePauses += 1;
      return { caughtUp: false, blockedByDiscovery: false, backpressured: true, backlog };
    }
    await validateProviders();
    const [watermark, discoveryWatermark, headValue] = await Promise.all([
      captureRepository.loadMarketScanWatermark(),
      captureRepository.loadDiscoveryScanWatermark(),
      client.requestProvider(roleName(options.headProvider), 'eth_blockNumber'),
    ]);
    const nextBlock = parseQuantity(
      watermark?.nextBlock ?? options.startBlock,
      'market scan nextBlock'
    );
    if (!discoveryWatermark) {
      return {
        caughtUp: false,
        blockedByDiscovery: true,
        nextBlock: nextBlock.toString(),
        discoveryThrough: null,
      };
    }
    const discoveryNext = parseQuantity(
      discoveryWatermark.nextBlock,
      'discovery nextBlock'
    );
    const head = parseQuantity(headValue, 'head');
    const confirmedHead = head >= BigInt(options.confirmations)
      ? head - BigInt(options.confirmations)
      : 0n;
    const discoveryThrough = discoveryNext > 0n ? discoveryNext - 1n : -1n;
    const safeHead = earlierBlock(confirmedHead, discoveryThrough);
    if (nextBlock > safeHead) {
      const caughtUp = nextBlock > confirmedHead;
      return {
        caughtUp,
        blockedByDiscovery: !caughtUp && nextBlock > discoveryThrough,
        nextBlock: nextBlock.toString(),
        safeHead: safeHead.toString(),
        confirmedHead: confirmedHead.toString(),
        discoveryThrough: discoveryThrough.toString(),
      };
    }
    const startedAt = now();
    const planned = [];
    let cursor = nextBlock;
    while (cursor <= safeHead && planned.length < options.inFlightRanges) {
      const requestedTo = cursor + BigInt(options.rangeSize) - 1n;
      const toBlock = requestedTo < safeHead ? requestedTo : safeHead;
      planned.push({ fromBlock: cursor, toBlock });
      cursor = toBlock + 1n;
    }
    status.currentRange = {
      provider: options.scanProvider,
      fromBlock: planned[0].fromBlock.toString(),
      toBlock: planned.at(-1).toBlock.toString(),
      phase: 'prefetching',
      plannedRanges: planned.length,
      bufferedLogs: 0,
      startedAt: new Date(startedAt).toISOString(),
    };
    const pools = await catalogRepository.listActivePools();
    let bufferedLogs = 0;
    async function fetchRange(fromBlock, toBlock) {
      const fetchStartedAt = new Date(now());
      let rawLogs;
      try {
        rawLogs = await client.requestProvider(
          roleName(options.scanProvider),
          'eth_getLogs',
          [{
            topics: [MARKET_TOPICS],
            fromBlock: toQuantity(fromBlock),
            toBlock: toQuantity(toBlock),
          }]
        );
        if (!Array.isArray(rawLogs)) throw new Error('eth_getLogs did not return an array');
      } catch (error) {
        if (!canSplitRange(error, fromBlock, toBlock)) throw error;
        rawLogs = null;
      }
      const width = toBlock - fromBlock + 1n;
      if (
        (rawLogs == null || rawLogs.length > options.maxLogsPerRange)
        && width > BigInt(options.minRangeSize)
      ) {
        status.totals.rangeSplits += 1;
        rawLogs = null;
        const midpoint = fromBlock + ((toBlock - fromBlock) / 2n);
        return [
          ...await fetchRange(fromBlock, midpoint),
          ...await fetchRange(midpoint + 1n, toBlock),
        ];
      }
      if (rawLogs == null) throw new Error('Dense range cannot be split below minRangeSize');
      const checkpointBlock = await client.requestProvider(
        roleName(options.scanProvider),
        'eth_getBlockByNumber',
        [toQuantity(toBlock), false]
      );
      if (bufferedLogs + rawLogs.length > options.maxBufferedLogs) {
        const error = new Error('Robinhood backfill reorder buffer limit exceeded');
        error.code = 'backfill_buffer_limit';
        throw error;
      }
      bufferedLogs += rawLogs.length;
      status.currentRange.bufferedLogs = bufferedLogs;
      return [{
        fromBlock,
        toBlock,
        rawLogs,
        trackedLogs: selectTrackedLogs(rawLogs, pools),
        checkpoint: checkpointFromBlock(checkpointBlock, toBlock),
        fetchStartedAt,
        fetchFinishedAt: new Date(now()),
      }];
    }
    const pending = planned.map(({ fromBlock, toBlock }) => (
      fetchRange(fromBlock, toBlock).then(
        (ranges) => ({ ranges }),
        (error) => ({ error })
      )
    ));
    const committed = [];
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const fetched = await pending[index];
        if (fetched.error) throw fetched.error;
        for (const range of fetched.ranges) {
          status.currentRange.phase = 'committing';
          const captured = await captureRepository.captureMarketRange({
            fromBlock: range.fromBlock.toString(),
            toBlock: range.toBlock.toString(),
            provider: options.scanProvider,
            decoderVersion: options.decoderVersion,
            rawLogCount: range.rawLogs.length,
            logs: range.trackedLogs,
            checkpoint: range.checkpoint,
            fetchStartedAt: range.fetchStartedAt,
            fetchFinishedAt: range.fetchFinishedAt,
          });
          bufferedLogs -= range.rawLogs.length;
          status.currentRange.bufferedLogs = bufferedLogs;
          status.totals.ranges += 1;
          status.totals.blocks += Number(range.toBlock - range.fromBlock + 1n);
          status.totals.rawLogs += range.rawLogs.length;
          status.totals.trackedLogs += range.trackedLogs.length;
          committed.push({ ...range, insertedLogs: captured.insertedLogs });
        }
      }
    } catch (error) {
      await Promise.all(pending);
      throw error;
    }
    const summary = {
      caughtUp: false,
      blockedByDiscovery: false,
      backpressured: false,
      provider: options.scanProvider,
      fromBlock: committed[0].fromBlock.toString(),
      toBlock: committed.at(-1).toBlock.toString(),
      ranges: committed.length,
      blocks: committed.reduce(
        (total, range) => total + Number(range.toBlock - range.fromBlock + 1n), 0
      ),
      rawLogs: committed.reduce((total, range) => total + range.rawLogs.length, 0),
      trackedLogs: committed.reduce((total, range) => total + range.trackedLogs.length, 0),
      insertedLogs: committed.reduce((total, range) => total + range.insertedLogs, 0),
      durationMs: Math.max(0, now() - startedAt),
    };
    return summary;
  }
  function runOnce() {
    if (activeRun) return activeRun;
    if (!options.enabled) return Promise.reject(new Error('Robinhood backfill shadow is disabled'));
    activeRun = (async () => {
      status.inFlight = true;
      try {
        const result = await scanBatch();
        status.lastRange = result;
        status.lastError = null;
        status.consecutiveErrors = 0;
        status.rpc = client?.getMetrics?.() || {};
        return result;
      } catch (error) {
        status.totals.errors += 1;
        status.consecutiveErrors += 1;
        status.lastError = String(error?.message || error).slice(0, 500);
        status.rpc = client?.getMetrics?.() || status.rpc;
        throw error;
      } finally {
        status.currentRange = null;
        status.inFlight = false;
        activeRun = null;
      }
    })();
    return activeRun;
  }
  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try { await runOnce(); } catch (error) {
        logger.error(`[RobinhoodBackfillScanner] ${error.message}`);
      } finally {
        const backoff = status.consecutiveErrors
          ? Math.min(options.maxErrorBackoffMs, options.intervalMs * (2 ** status.consecutiveErrors))
          : options.intervalMs;
        queueNext(backoff);
      }
    }, delayMs);
    timer?.unref?.();
  }
  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    client = null;
    captureRepository = null;
    catalogRepository = null;
    providersValidated = false;
    status.rpc = {};
    Object.assign(status, {
      enabled: options.enabled,
      scanProvider: options.scanProvider,
      headProvider: options.headProvider,
    });
    if (!options.enabled) return false;
    running = true;
    status.running = true;
    queueNext(0);
    return true;
  }
  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => {});
  }
  return Object.freeze({
    getStatus: () => ({
      ...status,
      currentRange: status.currentRange && { ...status.currentRange },
      lastRange: status.lastRange && { ...status.lastRange },
      totals: { ...status.totals },
    }),
    runOnce,
    start,
    stop,
  });
}
const scanner = createRobinhoodBackfillMarketScanner();
module.exports = {
  createRobinhoodBackfillMarketScanner,
  getStatus: scanner.getStatus,
  runOnce: scanner.runOnce,
  start: scanner.start,
  stop: scanner.stop,
  __private: { createClient, normalizeOptions, selectTrackedLogs },
};
