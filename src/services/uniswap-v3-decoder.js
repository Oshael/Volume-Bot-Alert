const ROBINHOOD_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const Q192 = 1n << 192n;

const TOPICS = Object.freeze({
  poolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  initialize: '0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95',
  swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
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
    protocol: 'uniswap-v3',
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
  return actualEmitter;
}

function selectQuote(token0, token1, quoteAddresses = [ROBINHOOD_WETH, ROBINHOOD_USDG]) {
  const normalizedToken0 = normalizeAddress(token0, 'token0');
  const normalizedToken1 = normalizeAddress(token1, 'token1');
  const quotes = new Set(quoteAddresses.map((address) => normalizeAddress(address, 'quote address')));
  const token0IsQuote = quotes.has(normalizedToken0);
  const token1IsQuote = quotes.has(normalizedToken1);
  if (token0IsQuote === token1IsQuote) {
    return { tracked: false, reason: token0IsQuote ? 'ambiguous_quote_pool' : 'unsupported_quote_pool' };
  }
  return {
    tracked: true,
    quoteIndex: token0IsQuote ? 0 : 1,
    quoteAddress: token0IsQuote ? normalizedToken0 : normalizedToken1,
    tokenAddress: token0IsQuote ? normalizedToken1 : normalizedToken0,
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

function decodePoolCreated(log, options = {}) {
  const factoryAddress = assertEvent(
    log,
    options.factoryAddress || ROBINHOOD_V3_FACTORY,
    TOPICS.poolCreated,
    4
  );
  const [tickSpacingWord, poolWord] = decodeWords(log.data, 2, 'PoolCreated data');
  const token0 = decodeAddressWord(log.topics[1], 'PoolCreated token0');
  const token1 = decodeAddressWord(log.topics[2], 'PoolCreated token1');
  const poolAddress = decodeAddressWord(poolWord, 'PoolCreated pool');
  return {
    kind: 'pool-created',
    ...eventContext(log),
    factoryAddress,
    poolAddress,
    marketKey: `robinhood:uniswap-v3:${poolAddress}`,
    token0,
    token1,
    fee: Number(decodeUint(log.topics[3], 24, 'PoolCreated fee')),
    tickSpacing: Number(decodeInt(tickSpacingWord, 24, 'PoolCreated tickSpacing')),
    ...selectQuote(token0, token1, options.quoteAddresses),
  };
}

function decodeInitialize(log, pool) {
  if (!pool?.tracked) throw new Error('Tracked pool context is required');
  assertEvent(log, pool.poolAddress, TOPICS.initialize, 1);
  const [sqrtWord, tickWord] = decodeWords(log.data, 2, 'Initialize data');
  const sqrtPriceX96 = decodeUint(sqrtWord, 160, 'Initialize sqrtPriceX96');
  return {
    kind: 'initialize',
    ...eventContext(log),
    poolAddress: pool.poolAddress,
    marketKey: pool.marketKey,
    tokenAddress: pool.tokenAddress,
    quoteAddress: pool.quoteAddress,
    fee: pool.fee,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(decodeInt(tickWord, 24, 'Initialize tick')),
    priceQuotePerTokenRaw: exactPriceRatio(sqrtPriceX96, pool),
  };
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

function decodeSwap(log, pool) {
  if (!pool?.tracked) throw new Error('Tracked pool context is required');
  assertEvent(log, pool.poolAddress, TOPICS.swap, 3);
  const [amount0Word, amount1Word, sqrtWord, liquidityWord, tickWord] = decodeWords(log.data, 5, 'Swap data');
  const amount0 = decodeInt(amount0Word, 256, 'Swap amount0');
  const amount1 = decodeInt(amount1Word, 256, 'Swap amount1');
  const sqrtPriceX96 = decodeUint(sqrtWord, 160, 'Swap sqrtPriceX96');
  const classified = classifySwap(amount0, amount1, pool);
  return {
    kind: 'swap',
    ...eventContext(log),
    poolAddress: pool.poolAddress,
    marketKey: pool.marketKey,
    tokenAddress: pool.tokenAddress,
    quoteAddress: pool.quoteAddress,
    quoteIndex: pool.quoteIndex,
    fee: pool.fee,
    sender: decodeAddressWord(log.topics[1], 'Swap sender'),
    recipient: decodeAddressWord(log.topics[2], 'Swap recipient'),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    liquidityRaw: decodeUint(liquidityWord, 128, 'Swap liquidity').toString(),
    tick: Number(decodeInt(tickWord, 24, 'Swap tick')),
    priceQuotePerTokenRaw: exactPriceRatio(sqrtPriceX96, pool),
    ...classified,
    ...(classified.accepted ? {
      quoteAmountRaw: classified.quoteAmountRaw.toString(),
      tokenAmountRaw: classified.tokenAmountRaw.toString(),
    } : {}),
  };
}

function createUniswapV3Tracker(options = {}) {
  const factoryAddress = normalizeAddress(options.factoryAddress || ROBINHOOD_V3_FACTORY);
  const pools = new Map();
  for (const pool of options.seedPools || []) {
    const poolAddress = normalizeAddress(pool.poolAddress, 'seed pool address');
    pools.set(poolAddress, { ...pool, poolAddress, tracked: true });
  }

  function processLog(log) {
    const emitter = normalizeAddress(log?.address, 'log.address');
    const topic0 = normalizeWord(log?.topics?.[0], 'topic0');
    if (emitter === factoryAddress) {
      if (topic0 !== TOPICS.poolCreated) return { kind: 'ignored', reason: 'unsupported_factory_event' };
      const event = decodePoolCreated(log, { ...options, factoryAddress });
      if (event.tracked) pools.set(event.poolAddress, event);
      return event;
    }
    const pool = pools.get(emitter);
    if (!pool) return { kind: 'ignored', reason: 'unknown_pool' };
    if (topic0 === TOPICS.initialize) return decodeInitialize(log, pool);
    if (topic0 === TOPICS.swap) return decodeSwap(log, pool);
    return { kind: 'ignored', reason: 'unsupported_pool_event' };
  }

  return Object.freeze({
    processLog,
    getPool: (address) => pools.get(normalizeAddress(address)) || null,
    getTrackedPoolCount: () => pools.size,
    getTrackedPools: () => [...pools.values()],
    removePool: (address) => pools.delete(normalizeAddress(address)),
  });
}

module.exports = {
  Q192,
  ROBINHOOD_USDG,
  ROBINHOOD_V3_FACTORY,
  ROBINHOOD_WETH,
  TOPICS,
  classifySwap,
  createUniswapV3Tracker,
  decodeInitialize,
  decodeInt,
  decodePoolCreated,
  decodeSwap,
  exactPriceRatio,
  selectQuote,
};
