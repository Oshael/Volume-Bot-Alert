const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_RANGE_SIZE = 10;
const DEFAULT_MAX_RANGE_SIZE = 250;
const DEFAULT_MAX_RANGES_PER_POLL = 20;
const DEFAULT_REORG_DEPTH = 12;
const DEFAULT_MAX_SEEN_LOGS = 10000;
const DEFAULT_MAX_ADDRESSES_PER_REQUEST = 100;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_POLL_MS = 15000;
function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function parseQuantity(value, label = 'quantity') {
  if (typeof value === 'bigint') return value;
  const raw = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error(`${label} must be a decimal or hex quantity`);
  }
  return BigInt(raw);
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function logIdentity(log) {
  const blockHash = String(log?.blockHash || '').toLowerCase();
  const transactionHash = String(log?.transactionHash || '').toLowerCase();
  const logIndex = String(log?.logIndex ?? '').toLowerCase();
  return blockHash && transactionHash && logIndex ? `${blockHash}:${transactionHash}:${logIndex}` : null;
}

function isAdaptiveRangeError(error) {
  return error?.code === 'rate_limited'
    || error?.code === 'timeout'
    || error?.code === 'log_range_error'
    || (error?.code === 'http_error' && [400, 408, 413, 429].includes(error.httpStatus));
}

function createMetrics() {
  return {
    polls: 0,
    ranges: 0,
    blocksProcessed: 0,
    backfillBlocks: 0,
    logsReceived: 0,
    logsAccepted: 0,
    logsDuplicate: 0,
    logsRemoved: 0,
    logRequests: 0,
    addressShardedRanges: 0,
    rangeShrinks: 0,
    rangeGrows: 0,
    reorgs: 0,
    errors: 0,
    lastError: null,
  };
}

function splitLogFilters(filter, maxAddressesPerRequest) {
  if (!Array.isArray(filter.address) || filter.address.length === 0) return [filter];
  const uniqueAddresses = [];
  const seen = new Set();
  for (const address of filter.address) {
    const key = String(address).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAddresses.push(address);
  }
  const filters = [];
  for (let index = 0; index < uniqueAddresses.length; index += maxAddressesPerRequest) {
    filters.push({
      ...filter,
      address: uniqueAddresses.slice(index, index + maxAddressesPerRequest),
    });
  }
  return filters;
}

function normalizeCheckpoint(value) {
  if (!value) return null;
  const checkpoint = {
    number: parseQuantity(value.number, 'checkpoint.number'),
    hash: String(value.hash || '').toLowerCase(),
    timestampMs: value.timestampMs ?? null,
  };
  if (!/^0x[0-9a-f]{64}$/.test(checkpoint.hash)) {
    throw new Error('checkpoint.hash must be a 32-byte hex value');
  }
  return checkpoint;
}

function createEvmLogPoller(options = {}) {
  const client = options.client;
  if (!client || typeof client.request !== 'function') throw new TypeError('EVM RPC client is required');
  const staticFilter = { ...(options.filter || {}) };
  delete staticFilter.fromBlock;
  delete staticFilter.toBlock;
  const getFilter = options.getFilter;
  if (getFilter != null && typeof getFilter !== 'function') throw new TypeError('getFilter must be a function');
  const confirmations = clampInteger(options.confirmations, DEFAULT_CONFIRMATIONS, 0, 1000);
  const minRangeSize = clampInteger(options.minRangeSize, 1, 1, 10000);
  const maxRangeSize = clampInteger(options.maxRangeSize, DEFAULT_MAX_RANGE_SIZE, minRangeSize, 100000);
  let rangeSize = clampInteger(options.rangeSize, DEFAULT_RANGE_SIZE, minRangeSize, maxRangeSize);
  const recoverRangeOnSuccess = options.recoverRangeOnSuccess === true;
  const rangeGrowthLimit = recoverRangeOnSuccess ? rangeSize : maxRangeSize;
  const maxRangesPerPoll = clampInteger(
    options.maxRangesPerPoll,
    DEFAULT_MAX_RANGES_PER_POLL,
    1,
    1000
  );
  const reorgDepth = clampInteger(options.reorgDepth, DEFAULT_REORG_DEPTH, 1, 1000);
  const maxSeenLogs = clampInteger(options.maxSeenLogs, DEFAULT_MAX_SEEN_LOGS, 1, 1000000);
  const maxAddressesPerRequest = clampInteger(
    options.maxAddressesPerRequest,
    DEFAULT_MAX_ADDRESSES_PER_REQUEST,
    1,
    1000
  );
  const growAfterSuccesses = clampInteger(options.growAfterSuccesses, 3, 1, 100);
  const normalPollMs = clampInteger(options.pollIntervalMs, DEFAULT_POLL_MS, 10, 300000);
  const maxPollMs = clampInteger(options.maxPollIntervalMs, DEFAULT_MAX_POLL_MS, normalPollMs, 600000);
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const onLogs = options.onLogs || (async () => {});
  const onRange = options.onRange || (async () => {});
  const onRemoved = options.onRemoved || (async () => {});
  const onReorg = options.onReorg || (async () => {});
  const onError = options.onError || (() => {});
  const seenLogs = new Map();
  const metrics = createMetrics();
  let nextBlock = options.startBlock == null ? null : parseQuantity(options.startBlock, 'startBlock');
  let headBlock = null;
  let safeHead = null;
  let checkpoint = normalizeCheckpoint(options.checkpoint);
  let rangeGrowthSuccesses = 0;
  let currentPollMs = normalPollMs;
  let polling = false;
  let running = false;
  let timer = null;

  function getStatus() {
    const lagBlocks = safeHead == null || nextBlock == null
      ? null
      : Number(safeHead >= nextBlock ? safeHead - nextBlock + 1n : 0n);
    return {
      running,
      polling,
      headBlock: headBlock?.toString() ?? null,
      safeHead: safeHead?.toString() ?? null,
      nextBlock: nextBlock?.toString() ?? null,
      lagBlocks,
      rangeSize,
      maxAddressesPerRequest,
      nextPollMs: currentPollMs,
      checkpoint: checkpoint ? {
        number: checkpoint.number.toString(),
        hash: checkpoint.hash,
        timestampMs: checkpoint.timestampMs,
      } : null,
      seenLogs: seenLogs.size,
      metrics: { ...metrics },
    };
  }

  function pruneSeenLogs() {
    const retainFrom = nextBlock > BigInt(reorgDepth) ? nextBlock - BigInt(reorgDepth) : 0n;
    for (const [key, entry] of seenLogs) {
      if (entry.blockNumber < retainFrom || seenLogs.size > maxSeenLogs) seenLogs.delete(key);
    }
  }

  async function readBlock(blockNumber, signal) {
    const block = await client.request('eth_getBlockByNumber', [toQuantity(blockNumber), false], { signal });
    const hash = String(block?.hash || '').toLowerCase();
    if (!hash) throw new Error(`Block ${blockNumber} did not include a hash`);
    let timestampMs = null;
    try {
      timestampMs = block?.timestamp == null ? null : Number(parseQuantity(block.timestamp, 'block.timestamp') * 1000n);
    } catch (_) {
      timestampMs = null;
    }
    return { number: blockNumber, hash, timestampMs };
  }

  async function rewindForReorg(signal) {
    if (!checkpoint) return false;
    const anchor = checkpoint.number > safeHead ? safeHead : checkpoint.number;
    if (checkpoint.number <= safeHead) {
      const current = await readBlock(checkpoint.number, signal);
      if (current.hash === checkpoint.hash) return false;
    }
    const depth = BigInt(reorgDepth);
    const rewindBlock = anchor >= depth - 1n ? anchor - depth + 1n : 0n;
    const affected = [...seenLogs.values()].filter((entry) => entry.blockNumber >= rewindBlock);
    const reason = checkpoint.number > safeHead ? 'safe_head_regressed' : 'checkpoint_hash_changed';
    await onReorg({
      reason,
      checkpoint: {
        number: checkpoint.number.toString(),
        hash: checkpoint.hash,
        timestampMs: checkpoint.timestampMs,
      },
      rewindBlock: rewindBlock.toString(),
    });
    if (affected.length) await onRemoved(affected.map((entry) => ({ ...entry.log, removed: true })), {
      reason,
      rewindBlock: rewindBlock.toString(),
    });
    for (const entry of affected) seenLogs.delete(entry.key);
    nextBlock = nextBlock == null || rewindBlock < nextBlock ? rewindBlock : nextBlock;
    checkpoint = null;
    metrics.reorgs += 1;
    metrics.logsRemoved += affected.length;
    return true;
  }

  function stageLogs(logs) {
    const accepted = [];
    const removed = [];
    const batchKeys = new Set();
    for (const log of logs) {
      const key = logIdentity(log);
      if (!key) throw new Error('RPC log is missing blockHash, transactionHash, or logIndex');
      if (log.removed) {
        if (seenLogs.has(key)) removed.push({ key, entry: seenLogs.get(key) });
        continue;
      }
      if (seenLogs.has(key) || batchKeys.has(key)) {
        metrics.logsDuplicate += 1;
        continue;
      }
      batchKeys.add(key);
      accepted.push({ key, blockNumber: parseQuantity(log.blockNumber, 'log.blockNumber'), log });
    }
    return { accepted, removed };
  }

  async function consumeRange(fromBlock, toBlock, logs, nextCheckpoint) {
    const staged = stageLogs(logs);
    const context = {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      backfill: toBlock < safeHead,
    };
    if (staged.removed.length) {
      await onRemoved(staged.removed.map(({ entry }) => ({ ...entry.log, removed: true })), {
        reason: 'rpc_removed_flag',
        ...context,
      });
    }
    const acceptedLogs = staged.accepted.map(({ log }) => log);
    const consumerResult = acceptedLogs.length ? await onLogs(acceptedLogs, context) : null;
    await onRange({
      ...context,
      logs: acceptedLogs,
      consumerResult,
      nextBlock: (toBlock + 1n).toString(),
      safeHead: safeHead.toString(),
      checkpoint: {
        number: nextCheckpoint.number.toString(),
        hash: nextCheckpoint.hash,
        timestampMs: nextCheckpoint.timestampMs,
      },
    });
    for (const { key } of staged.removed) seenLogs.delete(key);
    for (const entry of staged.accepted) seenLogs.set(entry.key, entry);
    metrics.logsRemoved += staged.removed.length;
    metrics.logsAccepted += staged.accepted.length;
    checkpoint = nextCheckpoint;
    nextBlock = toBlock + 1n;
    pruneSeenLogs();
  }

  function recordSuccessfulRange(fromBlock, toBlock, logCount) {
    const width = Number(toBlock - fromBlock + 1n);
    metrics.ranges += 1;
    metrics.blocksProcessed += width;
    if (toBlock < safeHead) metrics.backfillBlocks += width;
    const growthEligible = recoverRangeOnSuccess || logCount <= 10;
    rangeGrowthSuccesses = rangeSize < rangeGrowthLimit && growthEligible
      ? rangeGrowthSuccesses + 1
      : 0;
    if (rangeGrowthSuccesses >= growAfterSuccesses) {
      rangeSize = Math.min(rangeGrowthLimit, rangeSize * 2);
      rangeGrowthSuccesses = 0;
      metrics.rangeGrows += 1;
    }
  }

  async function processNextRange(signal) {
    const fromBlock = nextBlock;
    const toBlock = fromBlock + BigInt(rangeSize - 1) < safeHead
      ? fromBlock + BigInt(rangeSize - 1)
      : safeHead;
    let logs;
    try {
      const dynamicFilter = getFilter ? getFilter() : null;
      if (dynamicFilter != null && (typeof dynamicFilter !== 'object' || Array.isArray(dynamicFilter))) {
        throw new TypeError('getFilter must return an object');
      }
      const filter = { ...staticFilter, ...(dynamicFilter || {}) };
      delete filter.fromBlock;
      delete filter.toBlock;
      const rangeFilter = {
        ...filter,
        fromBlock: toQuantity(fromBlock),
        toBlock: toQuantity(toBlock),
      };
      const requestFilters = splitLogFilters(rangeFilter, maxAddressesPerRequest);
      if (requestFilters.length > 1) metrics.addressShardedRanges += 1;
      logs = [];
      for (const requestFilter of requestFilters) {
        metrics.logRequests += 1;
        const response = await client.request('eth_getLogs', [requestFilter], { signal });
        if (!Array.isArray(response)) throw new Error('eth_getLogs did not return an array');
        logs.push(...response);
      }
    } catch (error) {
      if (!isAdaptiveRangeError(error) || rangeSize <= minRangeSize) throw error;
      rangeSize = Math.max(minRangeSize, Math.floor(rangeSize / 2));
      rangeGrowthSuccesses = 0;
      metrics.rangeShrinks += 1;
      return false;
    }
    metrics.logsReceived += logs.length;
    const nextCheckpoint = await readBlock(toBlock, signal);
    await consumeRange(fromBlock, toBlock, logs, nextCheckpoint);
    recordSuccessfulRange(fromBlock, toBlock, logs.length);
    return true;
  }

  async function pollOnce(requestOptions = {}) {
    if (polling) throw new Error('EVM log poll already in progress');
    polling = true;
    metrics.polls += 1;
    try {
      headBlock = parseQuantity(await client.request('eth_blockNumber', [], requestOptions), 'eth_blockNumber');
      safeHead = headBlock >= BigInt(confirmations) ? headBlock - BigInt(confirmations) : 0n;
      if (nextBlock == null) nextBlock = safeHead;
      await rewindForReorg(requestOptions.signal);
      let completedRanges = 0;
      while (nextBlock <= safeHead && completedRanges < maxRangesPerPoll) {
        if (await processNextRange(requestOptions.signal)) completedRanges += 1;
      }
      const caughtUp = nextBlock > safeHead;
      currentPollMs = caughtUp
        ? Math.min(maxPollMs, completedRanges ? normalPollMs : currentPollMs * 2)
        : Math.min(250, normalPollMs);
      metrics.lastError = null;
      polling = false;
      return getStatus();
    } catch (error) {
      metrics.errors += 1;
      metrics.lastError = { code: error.code || 'poll_error', message: error.message };
      currentPollMs = Math.min(maxPollMs, Math.max(normalPollMs, currentPollMs * 2));
      throw error;
    } finally {
      polling = false;
    }
  }

  function queueNextPoll(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try {
        await pollOnce();
      } catch (error) {
        onError(error, getStatus());
      } finally {
        queueNextPoll(currentPollMs);
      }
    }, delayMs);
  }

  function start() {
    if (running) return false;
    running = true;
    queueNextPoll(0);
    return true;
  }

  function stop() {
    running = false;
    if (timer != null) cancelSchedule(timer);
    timer = null;
  }

  return Object.freeze({ pollOnce, start, stop, getStatus });
}

module.exports = {
  createEvmLogPoller,
  isAdaptiveRangeError,
  logIdentity,
  parseQuantity,
  splitLogFilters,
  toQuantity,
};
