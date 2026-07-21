const { formatDecimal, rational } = require('./evm-market-metrics');

const ROBINHOOD_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const CANONICAL_FEE = 100;
const GET_POOL_SELECTOR = '0x1698ee82';
const SLOT0_SELECTOR = '0x3850c7bd';
const LIQUIDITY_SELECTOR = '0x1a686502';
const RPC_FALLBACK_OPTIONS = Object.freeze({ fallbackOnRpcError: true });
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const Q192 = 1n << 192n;

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function addressWord(address) {
  return normalizeAddress(address).slice(2).padStart(64, '0');
}

function uintWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function buildGetPoolCall() {
  return `${GET_POOL_SELECTOR}${addressWord(ROBINHOOD_WETH)}${addressWord(ROBINHOOD_USDG)}${uintWord(CANONICAL_FEE)}`;
}

function decodeWord(data, index, label) {
  const raw = String(data || '').toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(raw) || (raw.length - 2) % 64 !== 0) throw new Error(`${label} is malformed ABI data`);
  const value = raw.slice(2 + (index * 64), 2 + ((index + 1) * 64));
  if (value.length !== 64) throw new Error(`${label} is missing ABI word ${index}`);
  return BigInt(`0x${value}`);
}

function decodeAddressResult(data) {
  const value = decodeWord(data, 0, 'getPool result').toString(16).padStart(64, '0');
  if (!/^0{24}[0-9a-f]{40}$/.test(value)) throw new Error('getPool result is not an ABI address');
  return `0x${value.slice(-40)}`;
}

function priceFromSqrtPriceX96(sqrtPriceX96) {
  const sqrt = BigInt(sqrtPriceX96);
  if (sqrt <= 0n || sqrt >= 1n << 160n) throw new Error('sqrtPriceX96 is outside uint160');
  return rational(sqrt * sqrt * (10n ** 18n), Q192 * (10n ** 6n));
}

function quantity(value, label) {
  const raw = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) throw new Error(`${label} is not a quantity`);
  return BigInt(raw);
}

function blockTag(value) {
  return `0x${value.toString(16)}`;
}

function isAdaptiveRangeError(error) {
  return error?.code === 'log_range_error'
    || error?.code === 'timeout'
    || error?.code === 'rate_limited'
    || (error?.code === 'http_error' && [400, 408, 413, 429].includes(error.httpStatus));
}

function compareLogs(left, right) {
  const blockDifference = quantity(left.blockNumber, 'log block') - quantity(right.blockNumber, 'log block');
  return blockDifference === 0n
    ? Number(quantity(left.logIndex, 'log index') - quantity(right.logIndex, 'log index'))
    : Number(blockDifference);
}

function sqrtPriceFromSwapLog(log) {
  if (String(log?.topics?.[0] || '').toLowerCase() !== SWAP_TOPIC) {
    throw new Error('Canonical quote log is not a V3 Swap');
  }
  const sqrtPriceX96 = decodeWord(log.data, 2, 'Swap data');
  if (sqrtPriceX96 <= 0n || sqrtPriceX96 >= 1n << 160n) {
    throw new Error('Swap sqrtPriceX96 is outside uint160');
  }
  return sqrtPriceX96;
}

function createRobinhoodWethUsdQuoteReader(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const rpcClient = options.rpcClient;
  const factoryAddress = normalizeAddress(options.factoryAddress || ROBINHOOD_V3_FACTORY);
  const now = options.now || Date.now;
  const configuredEventRangeSize = BigInt(options.eventRangeSize || 50000);
  const eventRangeSize = configuredEventRangeSize > 0n ? configuredEventRangeSize : 1n;
  const maxCacheEntries = Math.max(1, Math.trunc(Number(options.maxCacheEntries)) || 5000);
  const cache = new Map();
  const pending = new Map();
  let verifiedPool = null;
  let eventScan = null;
  let eventScanTail = Promise.resolve();

  function remember(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  async function resolvePool(blockTag) {
    if (verifiedPool) return verifiedPool;
    const result = await rpcClient.request(
      'eth_call',
      [{ to: factoryAddress, data: buildGetPoolCall() }, blockTag],
      RPC_FALLBACK_OPTIONS
    );
    const poolAddress = decodeAddressResult(result);
    if (poolAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('Canonical WETH/USDG pool is not deployed');
    }
    const code = String(await rpcClient.request(
      'eth_getCode',
      [poolAddress, blockTag],
      RPC_FALLBACK_OPTIONS
    ) || '').toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(code) || code === '0x' || code === '0x00') {
      throw new Error('Canonical WETH/USDG pool has no bytecode');
    }
    verifiedPool = poolAddress;
    return verifiedPool;
  }

  function snapshotFromSqrtPrice(sqrtPriceX96, requestOptions, details) {
    const price = priceFromSqrtPriceX96(sqrtPriceX96);
    return {
      pair: 'WETH/USDG',
      priceUsd: formatDecimal(price, requestOptions.decimalPlaces ?? 12),
      exact: { numerator: price.numerator.toString(), denominator: price.denominator.toString() },
      source: details.source,
      status: 'observed',
      confidence: 'medium',
      poolAddress: details.poolAddress,
      factoryAddress,
      fee: CANONICAL_FEE,
      sqrtPriceX96: String(sqrtPriceX96),
      liquidityRaw: details.liquidityRaw ?? null,
      blockTag: details.blockTag,
      sourceBlockTag: details.sourceBlockTag,
      observedAtMs: now(),
    };
  }

  async function readStateSnapshot(requestOptions, resolvedBlockTag) {
    const poolAddress = await resolvePool(resolvedBlockTag);
    const [slot0, liquidityResult] = await Promise.all([
      rpcClient.request(
        'eth_call',
        [{ to: poolAddress, data: SLOT0_SELECTOR }, resolvedBlockTag],
        RPC_FALLBACK_OPTIONS
      ),
      rpcClient.request(
        'eth_call',
        [{ to: poolAddress, data: LIQUIDITY_SELECTOR }, resolvedBlockTag],
        RPC_FALLBACK_OPTIONS
      ),
    ]);
    const sqrtPriceX96 = decodeWord(slot0, 0, 'slot0').toString();
    const liquidityRaw = decodeWord(liquidityResult, 0, 'liquidity').toString();
    return snapshotFromSqrtPrice(sqrtPriceX96, requestOptions, {
      source: 'canonical-uniswap-v3-weth-usdg-100',
      poolAddress,
      liquidityRaw,
      blockTag: resolvedBlockTag,
      sourceBlockTag: resolvedBlockTag,
    });
  }

  async function readLogs(filter) {
    try {
      const logs = await rpcClient.request('eth_getLogs', [filter]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs result must be an array');
      return logs;
    } catch (error) {
      const from = quantity(filter.fromBlock, 'fromBlock');
      const to = quantity(filter.toBlock, 'toBlock');
      if (!isAdaptiveRangeError(error) || from >= to) throw error;
      const middle = (from + to) / 2n;
      const [left, right] = await Promise.all([
        readLogs({ ...filter, toBlock: blockTag(middle) }),
        readLogs({ ...filter, fromBlock: blockTag(middle + 1n) }),
      ]);
      return [...left, ...right];
    }
  }

  async function logsInRange(poolAddress, fromBlock, toBlock) {
    if (fromBlock > toBlock) return [];
    return readLogs({
      address: poolAddress,
      fromBlock: blockTag(fromBlock),
      toBlock: blockTag(toBlock),
      topics: [SWAP_TOPIC],
    });
  }

  async function findLatestSwap(poolAddress, targetBlock) {
    if (eventScan && targetBlock >= eventScan.toBlock) {
      const logs = await logsInRange(poolAddress, eventScan.toBlock + 1n, targetBlock);
      const latest = logs.length ? logs.sort(compareLogs).at(-1) : eventScan.log;
      eventScan = { toBlock: targetBlock, log: latest };
      return latest;
    }
    let rangeEnd = targetBlock;
    while (rangeEnd >= 0n) {
      const rangeStart = rangeEnd >= eventRangeSize ? rangeEnd - eventRangeSize + 1n : 0n;
      const logs = await logsInRange(poolAddress, rangeStart, rangeEnd);
      if (logs.length) {
        const latest = logs.sort(compareLogs).at(-1);
        if (!eventScan || targetBlock > eventScan.toBlock) eventScan = { toBlock: targetBlock, log: latest };
        return latest;
      }
      if (rangeStart === 0n) return null;
      rangeEnd = rangeStart - 1n;
    }
    return null;
  }

  async function readEventSnapshot(requestOptions, resolvedBlockTag) {
    const targetBlock = quantity(resolvedBlockTag, 'blockTag');
    const poolAddress = await resolvePool('latest');
    const previous = eventScanTail;
    const task = previous.catch(() => {}).then(() => findLatestSwap(poolAddress, targetBlock));
    eventScanTail = task;
    const log = await task;
    if (!log) throw new Error(`No canonical WETH/USDG Swap at or before ${resolvedBlockTag}`);
    const sqrtPriceX96 = sqrtPriceFromSwapLog(log);
    return snapshotFromSqrtPrice(sqrtPriceX96, requestOptions, {
      source: 'canonical-uniswap-v3-weth-usdg-100-swap-event',
      poolAddress,
      blockTag: resolvedBlockTag,
      sourceBlockTag: blockTag(quantity(log.blockNumber, 'Swap blockNumber')),
    });
  }

  async function getSnapshot(requestOptions = {}) {
    const resolvedBlockTag = String(requestOptions.blockTag || 'latest');
    if (resolvedBlockTag === 'latest') return readStateSnapshot(requestOptions, resolvedBlockTag);
    const key = `${resolvedBlockTag}:${requestOptions.decimalPlaces ?? 12}`;
    if (cache.has(key)) return { ...cache.get(key), cached: true };
    if (pending.has(key)) return pending.get(key);
    const task = readStateSnapshot(requestOptions, resolvedBlockTag)
      .catch(() => readEventSnapshot(requestOptions, resolvedBlockTag))
      .then((snapshot) => {
        remember(key, snapshot);
        return { ...snapshot, cached: false };
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return Object.freeze({ getSnapshot, getCacheSize: () => cache.size });
}

module.exports = {
  CANONICAL_FEE,
  GET_POOL_SELECTOR,
  LIQUIDITY_SELECTOR,
  ROBINHOOD_USDG,
  ROBINHOOD_V3_FACTORY,
  ROBINHOOD_WETH,
  SLOT0_SELECTOR,
  SWAP_TOPIC,
  buildGetPoolCall,
  createRobinhoodWethUsdQuoteReader,
  decodeAddressResult,
  priceFromSqrtPriceX96,
};
