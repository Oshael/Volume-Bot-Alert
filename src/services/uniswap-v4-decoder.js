const ROBINHOOD_V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000';
const DYNAMIC_FEE_FLAG = 0x800000;
const Q192 = 1n << 192n;

const TOPICS = Object.freeze({
  initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  modifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
});

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function normalizeWord(value, label = 'word') {
  const word = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(word)) throw new Error(`${label} must be a 32-byte hex value`);
  return word;
}

function decodeWords(data, count, label) {
  const raw = String(data || '').toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`).test(raw)) {
    throw new Error(`${label} must contain exactly ${count} ABI words`);
  }
  return Array.from({ length: count }, (_, index) => (
    `0x${raw.slice(2 + (index * 64), 2 + ((index + 1) * 64))}`
  ));
}

function decodeAddressWord(value, label) {
  const word = normalizeWord(value, label);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) throw new Error(`${label} is not an ABI address word`);
  return `0x${word.slice(-40)}`;
}

function decodeUint(value, bits = 256, label = 'uint') {
  const decoded = BigInt(normalizeWord(value, label));
  if (decoded >= 1n << BigInt(bits)) throw new Error(`${label} exceeds uint${bits}`);
  return decoded;
}

function decodeInt(value, bits = 256, label = 'int') {
  const raw = BigInt(normalizeWord(value, label));
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (signed < min || signed > max) throw new Error(`${label} exceeds int${bits}`);
  return signed;
}

function decimalQuantity(value, label) {
  const raw = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) throw new Error(`${label} is not a quantity`);
  return BigInt(raw).toString();
}

function eventContext(log) {
  return {
    chain: 'robinhood',
    protocol: 'uniswap-v4',
    blockNumber: decimalQuantity(log?.blockNumber, 'blockNumber'),
    blockHash: normalizeWord(log?.blockHash, 'blockHash'),
    transactionHash: normalizeWord(log?.transactionHash, 'transactionHash'),
    logIndex: decimalQuantity(log?.logIndex, 'logIndex'),
    timestampMs: log?.blockTimestamp == null
      ? null
      : (BigInt(decimalQuantity(log.blockTimestamp, 'blockTimestamp')) * 1000n).toString(),
    source: 'robinhood-onchain',
  };
}

function assertEvent(log, emitter, topic, topicCount) {
  const actualEmitter = normalizeAddress(log?.address, 'log.address');
  if (actualEmitter !== normalizeAddress(emitter, 'expected emitter')) {
    throw new Error(`Unexpected log emitter ${actualEmitter}`);
  }
  if (!Array.isArray(log?.topics) || log.topics.length !== topicCount) {
    throw new Error(`Expected ${topicCount} event topics`);
  }
  if (normalizeWord(log.topics[0], 'topic0') !== topic) throw new Error('Unexpected event topic');
}

function selectQuote(currency0, currency1, options = {}) {
  const token0 = normalizeAddress(currency0, 'currency0');
  const token1 = normalizeAddress(currency1, 'currency1');
  const wrappedNative = normalizeAddress(options.wrappedNative || ROBINHOOD_WETH, 'wrapped native');
  const nativeCurrency = normalizeAddress(options.nativeCurrency || NATIVE_CURRENCY, 'native currency');
  const configured = options.quoteAddresses || [wrappedNative, ROBINHOOD_USDG];
  const quotes = new Set(configured.map((address) => normalizeAddress(address, 'quote address')));
  quotes.add(nativeCurrency);
  const currency0IsQuote = quotes.has(token0);
  const currency1IsQuote = quotes.has(token1);
  if (currency0IsQuote === currency1IsQuote) {
    return { tracked: false, reason: currency0IsQuote ? 'ambiguous_quote_pool' : 'unsupported_quote_pool' };
  }
  const quoteIndex = currency0IsQuote ? 0 : 1;
  const quoteCurrencyAddress = quoteIndex === 0 ? token0 : token1;
  return {
    tracked: true,
    quoteIndex,
    quoteCurrencyAddress,
    quoteAddress: quoteCurrencyAddress === nativeCurrency ? wrappedNative : quoteCurrencyAddress,
    quoteKind: quoteCurrencyAddress === nativeCurrency ? 'native' : 'erc20',
    tokenAddress: quoteIndex === 0 ? token1 : token0,
  };
}

function exactPriceRatio(sqrtPriceX96, pool) {
  const sqrtPrice = BigInt(sqrtPriceX96);
  if (sqrtPrice <= 0n) throw new Error('sqrtPriceX96 must be positive');
  const squared = sqrtPrice ** 2n;
  return pool.quoteIndex === 0
    ? { numerator: Q192.toString(), denominator: squared.toString() }
    : { numerator: squared.toString(), denominator: Q192.toString() };
}

function decodeInitialize(log, options = {}) {
  const poolManagerAddress = normalizeAddress(options.poolManagerAddress || ROBINHOOD_V4_POOL_MANAGER);
  assertEvent(log, poolManagerAddress, TOPICS.initialize, 4);
  const [feeWord, spacingWord, hooksWord, sqrtWord, tickWord] = decodeWords(log.data, 5, 'Initialize data');
  const currency0 = decodeAddressWord(log.topics[2], 'Initialize currency0');
  const currency1 = decodeAddressWord(log.topics[3], 'Initialize currency1');
  const fee = Number(decodeUint(feeWord, 24, 'Initialize fee'));
  const tickSpacing = Number(decodeInt(spacingWord, 24, 'Initialize tickSpacing'));
  if (tickSpacing <= 0) throw new Error('Initialize tickSpacing must be positive');
  const sqrtPriceX96 = decodeUint(sqrtWord, 160, 'Initialize sqrtPriceX96');
  const pool = {
    kind: 'initialize',
    ...eventContext(log),
    poolManagerAddress,
    poolAddress: null,
    poolId: normalizeWord(log.topics[1], 'Initialize poolId'),
    marketKey: `robinhood:uniswap-v4:${normalizeWord(log.topics[1], 'Initialize poolId')}`,
    currency0,
    currency1,
    fee,
    dynamicFee: (fee & DYNAMIC_FEE_FLAG) !== 0,
    tickSpacing,
    hooksAddress: decodeAddressWord(hooksWord, 'Initialize hooks'),
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(decodeInt(tickWord, 24, 'Initialize tick')),
    ...selectQuote(currency0, currency1, options),
  };
  return pool.tracked
    ? { ...pool, priceQuotePerTokenRaw: exactPriceRatio(sqrtPriceX96, pool) }
    : pool;
}

function classifySwap(amount0, amount1, pool) {
  const quoteDelta = pool.quoteIndex === 0 ? amount0 : amount1;
  const tokenDelta = pool.quoteIndex === 0 ? amount1 : amount0;
  if (quoteDelta > 0n && tokenDelta < 0n) {
    return { accepted: true, side: 'buy', quoteAmountRaw: quoteDelta, tokenAmountRaw: -tokenDelta };
  }
  if (quoteDelta < 0n && tokenDelta > 0n) {
    return { accepted: true, side: 'sell', quoteAmountRaw: -quoteDelta, tokenAmountRaw: tokenDelta };
  }
  return { accepted: false, reason: 'ambiguous_swap_deltas' };
}

function decodeSwap(log, pool, options = {}) {
  if (!pool?.tracked) throw new Error('Tracked pool context is required');
  assertEvent(log, options.poolManagerAddress || pool.poolManagerAddress, TOPICS.swap, 3);
  const poolId = normalizeWord(log.topics[1], 'Swap poolId');
  if (poolId !== pool.poolId) throw new Error('Swap poolId does not match pool context');
  const [amount0Word, amount1Word, sqrtWord, liquidityWord, tickWord, feeWord] = decodeWords(log.data, 6, 'Swap data');
  const amount0 = decodeInt(amount0Word, 128, 'Swap amount0');
  const amount1 = decodeInt(amount1Word, 128, 'Swap amount1');
  const sqrtPriceX96 = decodeUint(sqrtWord, 160, 'Swap sqrtPriceX96');
  const classified = classifySwap(amount0, amount1, pool);
  return {
    kind: 'swap',
    ...eventContext(log),
    poolAddress: null,
    poolId,
    marketKey: pool.marketKey,
    tokenAddress: pool.tokenAddress,
    quoteAddress: pool.quoteAddress,
    quoteCurrencyAddress: pool.quoteCurrencyAddress,
    quoteKind: pool.quoteKind,
    sender: decodeAddressWord(log.topics[2], 'Swap sender'),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    liquidityRaw: decodeUint(liquidityWord, 128, 'Swap liquidity').toString(),
    tick: Number(decodeInt(tickWord, 24, 'Swap tick')),
    fee: Number(decodeUint(feeWord, 24, 'Swap fee')),
    priceQuotePerTokenRaw: exactPriceRatio(sqrtPriceX96, pool),
    ...classified,
    ...(classified.accepted ? {
      quoteAmountRaw: classified.quoteAmountRaw.toString(),
      tokenAmountRaw: classified.tokenAmountRaw.toString(),
    } : {}),
  };
}

function decodeModifyLiquidity(log, pool, options = {}) {
  if (!pool?.tracked) throw new Error('Tracked pool context is required');
  assertEvent(
    log,
    options.poolManagerAddress || pool.poolManagerAddress,
    TOPICS.modifyLiquidity,
    3
  );
  const poolId = normalizeWord(log.topics[1], 'ModifyLiquidity poolId');
  if (poolId !== pool.poolId) throw new Error('ModifyLiquidity poolId does not match pool context');
  const [lowerWord, upperWord, deltaWord, saltWord] = decodeWords(
    log.data, 4, 'ModifyLiquidity data'
  );
  const tickLower = Number(decodeInt(lowerWord, 24, 'ModifyLiquidity tickLower'));
  const tickUpper = Number(decodeInt(upperWord, 24, 'ModifyLiquidity tickUpper'));
  if (tickLower >= tickUpper) throw new Error('ModifyLiquidity tick range must be increasing');
  if (tickLower % pool.tickSpacing !== 0 || tickUpper % pool.tickSpacing !== 0) {
    throw new Error('ModifyLiquidity ticks must align with pool tickSpacing');
  }
  return {
    kind: 'modify-liquidity',
    ...eventContext(log),
    poolAddress: null,
    poolId,
    marketKey: pool.marketKey,
    tokenAddress: pool.tokenAddress,
    quoteAddress: pool.quoteAddress,
    sender: decodeAddressWord(log.topics[2], 'ModifyLiquidity sender'),
    tickLower,
    tickUpper,
    liquidityDelta: decodeInt(deltaWord, 128, 'ModifyLiquidity liquidityDelta').toString(),
    salt: normalizeWord(saltWord, 'ModifyLiquidity salt'),
  };
}

function createUniswapV4Tracker(options = {}) {
  const poolManagerAddress = normalizeAddress(options.poolManagerAddress || ROBINHOOD_V4_POOL_MANAGER);
  const pools = new Map();
  for (const pool of options.seedPools || []) {
    const poolId = normalizeWord(pool.poolId, 'seed pool id');
    pools.set(poolId, { ...pool, poolId, poolManagerAddress, tracked: true });
  }
  function processLog(log) {
    if (normalizeAddress(log?.address, 'log.address') !== poolManagerAddress) {
      return { kind: 'ignored', reason: 'unexpected_emitter' };
    }
    const topic0 = normalizeWord(log?.topics?.[0], 'topic0');
    if (topic0 === TOPICS.initialize) {
      const event = decodeInitialize(log, { ...options, poolManagerAddress });
      if (event.tracked) pools.set(event.poolId, event);
      return event;
    }
    if (topic0 === TOPICS.swap) {
      const poolId = normalizeWord(log?.topics?.[1], 'Swap poolId');
      const pool = pools.get(poolId);
      return pool ? decodeSwap(log, pool, { poolManagerAddress }) : { kind: 'ignored', reason: 'unknown_pool' };
    }
    if (topic0 === TOPICS.modifyLiquidity) {
      const poolId = normalizeWord(log?.topics?.[1], 'ModifyLiquidity poolId');
      const pool = pools.get(poolId);
      return pool
        ? decodeModifyLiquidity(log, pool, { poolManagerAddress })
        : { kind: 'ignored', reason: 'unknown_pool' };
    }
    return { kind: 'ignored', reason: 'unsupported_pool_manager_event' };
  }
  return Object.freeze({
    processLog,
    getPool: (poolId) => pools.get(normalizeWord(poolId, 'poolId')) || null,
    getTrackedPoolCount: () => pools.size,
    getTrackedPools: () => [...pools.values()],
    removePool: (poolId) => pools.delete(normalizeWord(poolId, 'poolId')),
  });
}

module.exports = {
  DYNAMIC_FEE_FLAG,
  NATIVE_CURRENCY,
  Q192,
  ROBINHOOD_USDG,
  ROBINHOOD_V4_POOL_MANAGER,
  ROBINHOOD_WETH,
  TOPICS,
  classifySwap,
  createUniswapV4Tracker,
  decodeInitialize,
  decodeInt,
  decodeModifyLiquidity,
  decodeSwap,
  exactPriceRatio,
  selectQuote,
};
