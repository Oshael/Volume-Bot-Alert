'use strict';

const {
  CANONICAL_CONTRACTS,
  ROBINHOOD_TOKENIZED_ASSETS,
} = require('./robinhood-market-policy');
const {
  formatDecimal,
  multiply,
  parseDecimal,
  rational,
} = require('./evm-market-metrics');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');

const GET_RESERVES_SELECTOR = '0x0902f1ac';
const SLOT0_SELECTOR = '0x3850c7bd';
const V4_GET_SLOT0_SELECTOR = '0xc815641c';
const RPC_OPTIONS = Object.freeze({ fallbackOnRpcError: true });
const STOCKS = new Set(Object.values(ROBINHOOD_TOKENIZED_ASSETS));
const STOCK_USD_REFERENCE_MISSING_ERROR_CODE = 'stock_usd_reference_missing';

function address(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function blockTag(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error('blockTag must identify an exact block');
  }
  return `0x${BigInt(raw).toString(16)}`;
}

function decodeWord(data, index, bits, label) {
  const raw = String(data || '').trim().toLowerCase();
  if (!/^0x(?:[0-9a-f]{64})+$/.test(raw)) throw new Error(`${label} is malformed`);
  const word = raw.slice(2 + index * 64, 2 + (index + 1) * 64);
  if (word.length !== 64) throw new Error(`${label} is missing word ${index}`);
  const value = BigInt(`0x${word}`);
  if (value >= 1n << BigInt(bits)) throw new Error(`${label} exceeds uint${bits}`);
  return value;
}

function bytes32Call(selector, value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('poolId is invalid');
  return `${selector}${normalized.slice(2)}`;
}

function quoteIndex(reference) {
  const token = address(reference.tokenAddress, 'reference tokenAddress');
  const currency0 = address(reference.currency0, 'reference currency0');
  const currency1 = address(reference.currency1, 'reference currency1');
  if (currency0 === token && currency1 !== token) return 1;
  if (currency1 === token && currency0 !== token) return 0;
  throw new Error('stock reference currencies are inconsistent');
}

function decimals(metadata, label) {
  const value = Number(metadata?.decimals);
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} decimals are unavailable`);
  }
  return value;
}

function normalizePrice(rawRatio, tokenDecimals, quoteDecimals, quoteUsdPrice) {
  return multiply(
    rational(rawRatio.numerator, rawRatio.denominator),
    rational(10n ** BigInt(tokenDecimals), 10n ** BigInt(quoteDecimals)),
    parseDecimal(quoteUsdPrice)
  );
}

function errorResult(stockAddress, block, failures) {
  const error = new Error(`stock USD reference is unavailable for ${stockAddress} at ${block}`);
  error.code = failures.length
    ? 'stock_usd_reference_unavailable' : STOCK_USD_REFERENCE_MISSING_ERROR_CODE;
  error.retryable = failures.length > 0;
  error.details = { stockAddress, blockTag: block, failures };
  return error;
}

function createRobinhoodStockUsdQuoteReader(options = {}) {
  const rpcClient = options.rpcClient;
  const repository = options.repository;
  const metadataReader = options.metadataReader;
  const wethQuoteReader = options.wethQuoteReader;
  const stateViewAddress = address(
    options.stateViewAddress || CANONICAL_CONTRACTS.UNISWAP_V4_STATE_VIEW,
    'stateViewAddress'
  );
  if (typeof rpcClient?.request !== 'function') throw new Error('rpcClient is required');
  if (typeof repository?.listStockUsdReferences !== 'function') {
    throw new Error('repository is required');
  }
  if (typeof metadataReader?.getMetadata !== 'function') throw new Error('metadataReader is required');
  if (typeof wethQuoteReader?.getSnapshot !== 'function') {
    throw new Error('wethQuoteReader is required');
  }
  const maximum = Number(options.maxCacheEntries ?? 5000);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) {
    throw new RangeError('maxCacheEntries must be between 1 and 100000');
  }
  const cache = new Map();
  const pending = new Map();

  async function rpcCall(to, data, resolvedBlockTag) {
    return rpcClient.request('eth_call', [{ to, data }, resolvedBlockTag], RPC_OPTIONS);
  }

  async function rawPrice(reference, resolvedBlockTag) {
    const index = quoteIndex(reference);
    if (reference.protocol === 'uniswap-v2') {
      const reserves = await rpcCall(reference.poolAddress, GET_RESERVES_SELECTOR, resolvedBlockTag);
      const tokenReserve = decodeWord(reserves, index === 0 ? 1 : 0, 112, 'V2 reserves');
      const quoteReserve = decodeWord(reserves, index, 112, 'V2 reserves');
      if (tokenReserve === 0n || quoteReserve === 0n) throw new Error('V2 reserves are empty');
      return rational(quoteReserve, tokenReserve);
    }
    const target = reference.protocol === 'uniswap-v3'
      ? reference.poolAddress : stateViewAddress;
    const data = reference.protocol === 'uniswap-v3'
      ? SLOT0_SELECTOR : bytes32Call(V4_GET_SLOT0_SELECTOR, reference.poolId);
    const slot0 = await rpcCall(target, data, resolvedBlockTag);
    const sqrtPriceX96 = decodeWord(slot0, 0, 160, `${reference.protocol} slot0`);
    return (reference.protocol === 'uniswap-v3' ? v3 : v4)
      .exactPriceRatio(sqrtPriceX96, { quoteIndex: index });
  }

  async function eventCheckpoint(stockAddress, resolvedBlockTag) {
    if (typeof repository.findStockUsdEventCheckpoint !== 'function') return null;
    const checkpoint = await repository.findStockUsdEventCheckpoint({
      stockAddress, blockNumber: BigInt(resolvedBlockTag).toString(),
    });
    if (!checkpoint) return null;
    const reference = checkpoint.reference;
    const index = quoteIndex(reference);
    const pool = {
      tracked: true, marketKey: reference.marketKey,
      tokenAddress: reference.tokenAddress, quoteAddress: reference.quoteAddress,
      quoteIndex: index,
      ...(reference.protocol === 'uniswap-v2'
        ? { pairAddress: reference.poolAddress }
        : reference.protocol === 'uniswap-v3'
        ? { poolAddress: reference.poolAddress }
        : { poolId: reference.poolId, poolManagerAddress: reference.originAddress }),
    };
    let ratio;
    if (reference.protocol === 'uniswap-v2') {
      const sync = v2.decodeSync(checkpoint.log, pool);
      const tokenReserve = BigInt(sync.tokenReserveRaw);
      const quoteReserve = BigInt(sync.quoteReserveRaw);
      if (tokenReserve === 0n || quoteReserve === 0n) return null;
      ratio = rational(quoteReserve, tokenReserve);
    } else {
      const swap = reference.protocol === 'uniswap-v3'
        ? v3.decodeSwap(checkpoint.log, pool)
        : v4.decodeSwap(checkpoint.log, pool, { poolManagerAddress: reference.originAddress });
      ratio = swap.priceQuotePerTokenRaw;
    }
    const [tokenMetadata, quoteMetadata] = await Promise.all([
      metadataReader.getMetadata(stockAddress),
      metadataReader.getMetadata(reference.quoteAddress),
    ]);
    const price = normalizePrice(
      ratio,
      decimals(tokenMetadata, 'stock'), decimals(quoteMetadata, 'quote'), '1'
    );
    return Object.freeze({
      priceUsd: formatDecimal(price, 12),
      exact: { numerator: price.numerator.toString(), denominator: price.denominator.toString() },
      source: `canonical-${reference.protocol}-stock-usdg-journal`,
      status: 'observed', confidence: 'medium', stockAddress,
      referenceProtocol: reference.protocol, referenceMarketKey: reference.marketKey,
      referencePool: reference.poolAddress || reference.poolId,
      blockTag: blockTag(checkpoint.log.blockNumber), requestedBlockTag: resolvedBlockTag,
    });
  }

  async function resolve(stockAddress, resolvedBlockTag) {
    const references = await repository.listStockUsdReferences({
      stockAddress, blockNumber: BigInt(resolvedBlockTag).toString(),
    });
    const metadata = new Map();
    const readMetadata = (currency) => {
      if (!metadata.has(currency)) {
        metadata.set(currency, metadataReader.getMetadata(currency, { blockTag: resolvedBlockTag }));
      }
      return metadata.get(currency);
    };
    let wethUsd = null;
    const failures = [];
    for (const reference of references) {
      try {
        if (!['uniswap-v2', 'uniswap-v3', 'uniswap-v4'].includes(reference.protocol)) {
          throw new Error('reference protocol is unsupported');
        }
        const quoteAddress = address(reference.quoteAddress, 'reference quoteAddress');
        if (![CANONICAL_CONTRACTS.USDG, CANONICAL_CONTRACTS.WETH].includes(quoteAddress)) {
          throw new Error('reference quote is unsupported');
        }
        const [tokenMetadata, quoteMetadata, ratio] = await Promise.all([
          readMetadata(stockAddress), readMetadata(quoteAddress),
          rawPrice(reference, resolvedBlockTag),
        ]);
        if (quoteAddress === CANONICAL_CONTRACTS.WETH && !wethUsd) {
          wethUsd = await wethQuoteReader.getSnapshot({ blockTag: resolvedBlockTag });
        }
        const price = normalizePrice(
          ratio, decimals(tokenMetadata, 'stock'), decimals(quoteMetadata, 'quote'),
          quoteAddress === CANONICAL_CONTRACTS.USDG ? '1' : wethUsd.priceUsd
        );
        if (price.numerator <= 0n) throw new Error('stock USD price is not positive');
        return Object.freeze({
          priceUsd: formatDecimal(price, 12),
          exact: { numerator: price.numerator.toString(), denominator: price.denominator.toString() },
          source: `canonical-${reference.protocol}-stock-${
            quoteAddress === CANONICAL_CONTRACTS.USDG ? 'usdg' : 'weth-usd'
          }`,
          status: 'observed', confidence: 'medium', stockAddress,
          referenceProtocol: reference.protocol, referenceMarketKey: reference.marketKey,
          referencePool: reference.poolAddress || reference.poolId,
          blockTag: resolvedBlockTag,
        });
      } catch (error) {
        failures.push({
          protocol: reference.protocol, marketKey: reference.marketKey,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }
    const journalCheckpoint = await eventCheckpoint(stockAddress, resolvedBlockTag);
    if (journalCheckpoint) return journalCheckpoint;
    throw errorResult(stockAddress, resolvedBlockTag, failures);
  }

  function remember(key, value) {
    cache.set(key, value);
    while (cache.size > maximum) cache.delete(cache.keys().next().value);
  }

  async function getSnapshot(input = {}) {
    const stockAddress = address(input.stockAddress, 'stockAddress');
    if (!STOCKS.has(stockAddress)) throw new Error('stockAddress is not an official stock token');
    const resolvedBlockTag = blockTag(input.blockTag);
    const key = `${stockAddress}:${resolvedBlockTag}`;
    if (cache.has(key)) return { ...cache.get(key), cached: true };
    if (pending.has(key)) return pending.get(key);
    const task = resolve(stockAddress, resolvedBlockTag)
      .then((snapshot) => { remember(key, snapshot); return { ...snapshot, cached: false }; })
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return Object.freeze({ getSnapshot, getCacheSize: () => cache.size });
}

module.exports = {
  GET_RESERVES_SELECTOR,
  SLOT0_SELECTOR,
  V4_GET_SLOT0_SELECTOR,
  STOCK_USD_REFERENCE_MISSING_ERROR_CODE,
  createRobinhoodStockUsdQuoteReader,
};
