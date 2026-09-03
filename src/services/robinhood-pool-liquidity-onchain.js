const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');
const {
  CANONICAL_CONTRACTS,
  buildLiquidityAssessment,
} = require('./robinhood-market-policy');
const {
  ROBINHOOD_WETH,
  formatDecimal,
  multiply,
  parseDecimal,
  rational,
  resolveQuoteUsd,
} = require('./evm-market-metrics');

const GET_RESERVES_SELECTOR = '0x0902f1ac';
const SLOT0_SELECTOR = '0x3850c7bd';
const LIQUIDITY_SELECTOR = '0x1a686502';
const V4_GET_SLOT0_SELECTOR = '0xc815641c';
const V4_GET_LIQUIDITY_SELECTOR = '0xfa6793d5';
const RPC_OPTIONS = Object.freeze({ fallbackOnRpcError: true });

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error(`${label} is invalid`);
  }
  return BigInt(raw);
}

function blockTag(value) {
  return `0x${quantity(value, 'block number').toString(16)}`;
}

function hexData(value, label) {
  const raw = String(value || '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{64})+$/.test(raw)) throw new Error(`${label} is malformed`);
  return raw;
}

function decodeWord(data, index, bits, label) {
  const raw = hexData(data, label).slice(2);
  const word = raw.slice(index * 64, (index + 1) * 64);
  if (word.length !== 64) throw new Error(`${label} is missing word ${index}`);
  const value = BigInt(`0x${word}`);
  if (value >= 1n << BigInt(bits)) throw new Error(`${label} exceeds uint${bits}`);
  return value;
}

function bytes32Call(selector, value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return `${selector}${normalized.slice(2)}`;
}

function normalizeAnchor(block) {
  const number = quantity(block?.number, 'anchor block number');
  const hash = String(block?.hash || '').toLowerCase();
  const timestampSeconds = quantity(block?.timestamp, 'anchor block timestamp');
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('anchor block hash is invalid');
  const observedAt = new Date(Number(timestampSeconds * 1000n));
  if (!Number.isFinite(observedAt.getTime())) throw new Error('anchor block timestamp is invalid');
  return Object.freeze({
    number: number.toString(), hash, blockTag: blockTag(number),
    observedAt: observedAt.toISOString(),
  });
}

function inputAnchor(anchor) {
  return normalizeAnchor({
    number: anchor?.number, hash: anchor?.hash,
    timestamp: BigInt(new Date(anchor?.observedAt).getTime()) / 1000n,
  });
}

function quoteIndex(pool) {
  const token = String(pool.tokenAddress || '').toLowerCase();
  const currency0 = String(pool.currency0 || '').toLowerCase();
  const currency1 = String(pool.currency1 || '').toLowerCase();
  if (currency0 === token && currency1 !== token) return 1;
  if (currency1 === token && currency0 !== token) return 0;
  throw new Error('pool currencies do not identify exactly one token side');
}

function tokenUsdPrice(protocol, sqrtPriceX96, pool, metadata, quoteUsdPrice) {
  const index = quoteIndex(pool);
  const exact = protocol === 'uniswap-v3'
    ? v3.exactPriceRatio(sqrtPriceX96, { quoteIndex: index })
    : v4.exactPriceRatio(sqrtPriceX96, { quoteIndex: index });
  return formatDecimal(multiply(
    rational(exact.numerator, exact.denominator),
    rational(10n ** BigInt(metadata.token.decimals), 10n ** BigInt(metadata.quote.decimals)),
    parseDecimal(quoteUsdPrice)
  ), 80);
}

function createRobinhoodPoolLiquidityOnchainReader(deps = {}) {
  const rpcClient = deps.rpcClient;
  const metadataReader = deps.metadataReader;
  const quoteReader = deps.quoteReader;
  const v4RangeReader = deps.v4RangeReader;
  const assessLiquidity = deps.assessLiquidity || buildLiquidityAssessment;
  const stateViewAddress = String(
    deps.stateViewAddress || CANONICAL_CONTRACTS.UNISWAP_V4_STATE_VIEW
  ).toLowerCase();
  if (typeof rpcClient?.request !== 'function') throw new Error('rpcClient is required');
  if (typeof metadataReader?.getMetadata !== 'function'
    || typeof metadataReader?.getBalanceOf !== 'function') {
    throw new Error('metadataReader is required');
  }
  if (typeof quoteReader?.getSnapshot !== 'function') throw new Error('quoteReader is required');
  if (typeof v4RangeReader?.listHistoricalV4LiquidityRanges !== 'function') {
    throw new Error('v4RangeReader is required');
  }

  async function readAnchor(tag = 'latest') {
    const block = await rpcClient.request('eth_getBlockByNumber', [String(tag), false]);
    if (!block) throw new Error(`anchor block ${tag} is unavailable`);
    return normalizeAnchor(block);
  }

  async function metadata(pool, anchor) {
    const [token, quote] = await Promise.all([
      metadataReader.getMetadata(pool.tokenAddress, { blockTag: anchor.blockTag }),
      metadataReader.getMetadata(pool.quoteAddress, { blockTag: anchor.blockTag }),
    ]);
    if (!token?.usable || !quote?.usable) throw new Error('pool metadata is unavailable');
    return { token, quote };
  }

  async function quoteUsd(pool, anchor) {
    const options = pool.quoteAddress === ROBINHOOD_WETH
      ? await quoteReader.getSnapshot({ blockTag: anchor.blockTag }) : {};
    const resolved = resolveQuoteUsd(pool.quoteAddress, {
      wethUsdPrice: options.priceUsd, wethUsdSource: options.source,
    });
    if (!resolved) throw new Error('pool quote USD price is unavailable');
    return formatDecimal(resolved.price, 12);
  }

  async function rpcCall(to, data, anchor) {
    return rpcClient.request('eth_call', [{ to, data }, anchor.blockTag], RPC_OPTIONS);
  }

  async function v2Inputs(pool, anchor, resolvedMetadata, quoteUsdPrice) {
    const reserves = await rpcCall(pool.poolAddress, GET_RESERVES_SELECTOR, anchor);
    const index = quoteIndex(pool);
    return {
      protocol: pool.protocol,
      quoteReserveRaw: decodeWord(reserves, index, 112, 'V2 getReserves').toString(),
      quoteDecimals: resolvedMetadata.quote.decimals,
      quoteUsdPrice,
    };
  }

  async function v3Inputs(pool, anchor, resolvedMetadata, quoteUsdPrice) {
    const [slot0, liquidity, tokenBalance, quoteBalance] = await Promise.all([
      rpcCall(pool.poolAddress, SLOT0_SELECTOR, anchor),
      rpcCall(pool.poolAddress, LIQUIDITY_SELECTOR, anchor),
      metadataReader.getBalanceOf(pool.tokenAddress, pool.poolAddress, {
        blockTag: anchor.blockTag,
      }),
      metadataReader.getBalanceOf(pool.quoteAddress, pool.poolAddress, {
        blockTag: anchor.blockTag,
      }),
    ]);
    if (tokenBalance.balanceRaw == null || quoteBalance.balanceRaw == null) {
      throw new Error('V3 pool balances are unavailable');
    }
    const sqrtPriceX96 = decodeWord(slot0, 0, 160, 'V3 slot0').toString();
    return {
      protocol: pool.protocol,
      liquidityRaw: decodeWord(liquidity, 0, 128, 'V3 liquidity').toString(),
      tokenBalanceRaw: tokenBalance.balanceRaw, quoteBalanceRaw: quoteBalance.balanceRaw,
      tokenDecimals: resolvedMetadata.token.decimals,
      quoteDecimals: resolvedMetadata.quote.decimals,
      tokenUsdPrice: tokenUsdPrice(
        pool.protocol, sqrtPriceX96, pool, resolvedMetadata, quoteUsdPrice
      ),
      quoteUsdPrice,
    };
  }

  function readRanges(pool, anchor, prefetched) {
    if (prefetched) {
      const id = String(pool.poolId).toLowerCase();
      if (!prefetched.has(id)) throw new Error('pool is outside the prefetched liquidity batch');
      return prefetched.get(id);
    }
    return v4RangeReader.listHistoricalV4LiquidityRanges(
      pool.poolId, (BigInt(anchor.number) + 1n).toString(), '0'
    );
  }

  async function v4Inputs(pool, anchor, resolvedMetadata, quoteUsdPrice, prefetched) {
    const [slot0, liquidity, ranges] = await Promise.all([
      rpcCall(stateViewAddress, bytes32Call(V4_GET_SLOT0_SELECTOR, pool.poolId, 'poolId'), anchor),
      rpcCall(stateViewAddress, bytes32Call(
        V4_GET_LIQUIDITY_SELECTOR, pool.poolId, 'poolId'
      ), anchor),
      readRanges(pool, anchor, prefetched),
    ]);
    const sqrtPriceX96 = decodeWord(slot0, 0, 160, 'V4 getSlot0').toString();
    return {
      protocol: pool.protocol,
      liquidityRaw: decodeWord(liquidity, 0, 128, 'V4 getLiquidity').toString(),
      sqrtPriceX96, quoteIndex: quoteIndex(pool), v4Ranges: ranges,
      tokenDecimals: resolvedMetadata.token.decimals,
      quoteDecimals: resolvedMetadata.quote.decimals,
      tokenUsdPrice: tokenUsdPrice(
        pool.protocol, sqrtPriceX96, pool, resolvedMetadata, quoteUsdPrice
      ),
      quoteUsdPrice,
    };
  }

  async function valuePool(pool, anchorInput, prefetched) {
    const anchor = inputAnchor(anchorInput);
    const [resolvedMetadata, quoteUsdPrice] = await Promise.all([
      metadata(pool, anchor), quoteUsd(pool, anchor),
    ]);
    let inputs;
    if (pool.protocol === 'uniswap-v2') {
      inputs = await v2Inputs(pool, anchor, resolvedMetadata, quoteUsdPrice);
    } else if (pool.protocol === 'uniswap-v3') {
      inputs = await v3Inputs(pool, anchor, resolvedMetadata, quoteUsdPrice);
    } else if (pool.protocol === 'uniswap-v4') {
      inputs = await v4Inputs(pool, anchor, resolvedMetadata, quoteUsdPrice, prefetched);
    } else {
      throw new Error('pool protocol is unsupported');
    }
    return Object.freeze({ ...anchor, ...assessLiquidity(inputs) });
  }

  async function forPoolsAtAnchor(pools, anchorInput) {
    if (pools.length > 50) throw new RangeError('at most 50 pools are allowed');
    const ids = [...new Set(pools.filter((pool) => pool.protocol === 'uniswap-v4')
      .map((pool) => String(pool.poolId || '').trim().toLowerCase())
      .filter((id) => /^0x[0-9a-f]{64}$/.test(id)))];
    if (!ids.length || typeof v4RangeReader.listHistoricalV4LiquidityRangesByPoolIds !== 'function') {
      return { valuePool };
    }
    const anchor = inputAnchor(anchorInput);
    const ranges = await v4RangeReader.listHistoricalV4LiquidityRangesByPoolIds(
      ids, (BigInt(anchor.number) + 1n).toString(), '0'
    );
    return { valuePool(pool, requestedAnchor) {
      const requested = inputAnchor(requestedAnchor);
      if (requested.number !== anchor.number || requested.hash !== anchor.hash) {
        throw new Error('prefetched liquidity anchor does not match');
      }
      return valuePool(pool, requested, ranges);
    } };
  }

  return Object.freeze({ readAnchor, valuePool, forPoolsAtAnchor });
}

module.exports = {
  GET_RESERVES_SELECTOR,
  LIQUIDITY_SELECTOR,
  SLOT0_SELECTOR,
  V4_GET_LIQUIDITY_SELECTOR,
  V4_GET_SLOT0_SELECTOR,
  createRobinhoodPoolLiquidityOnchainReader,
  __private: { decodeWord, normalizeAnchor, quoteIndex, tokenUsdPrice },
};
