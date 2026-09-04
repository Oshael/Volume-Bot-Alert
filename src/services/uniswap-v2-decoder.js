const ROBINHOOD_V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const TOPICS = Object.freeze({
  pairCreated: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  swap: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  sync: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
});

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function normalizeTopic(value, label = 'topic') {
  const topic = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(topic)) throw new Error(`${label} must be a 32-byte hex value`);
  return topic;
}

function decodeAddressWord(value, label) {
  const word = normalizeTopic(value, label);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) throw new Error(`${label} is not an ABI address word`);
  return `0x${word.slice(-40)}`;
}

function decodeWords(data, count, label) {
  const raw = String(data || '').toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`).test(raw)) {
    throw new Error(`${label} must contain exactly ${count} ABI words`);
  }
  const words = [];
  for (let index = 0; index < count; index += 1) {
    words.push(`0x${raw.slice(2 + (index * 64), 2 + ((index + 1) * 64))}`);
  }
  return words;
}

function decodeUint(word) {
  return BigInt(normalizeTopic(word, 'uint256 word'));
}

function decimalQuantity(value, label) {
  const raw = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) throw new Error(`${label} is not a quantity`);
  return BigInt(raw).toString();
}

function eventContext(log) {
  const timestampMs = log?.blockTimestamp == null
    ? null
    : (BigInt(decimalQuantity(log.blockTimestamp, 'blockTimestamp')) * 1000n).toString();
  return {
    chain: 'robinhood',
    protocol: 'uniswap-v2',
    blockNumber: decimalQuantity(log?.blockNumber, 'blockNumber'),
    blockHash: normalizeTopic(log?.blockHash, 'blockHash'),
    transactionHash: normalizeTopic(log?.transactionHash, 'transactionHash'),
    logIndex: decimalQuantity(log?.logIndex, 'logIndex'),
    timestampMs,
    source: 'robinhood-onchain',
  };
}

function assertEmitter(log, expectedAddress) {
  const emitter = normalizeAddress(log?.address, 'log.address');
  if (emitter !== normalizeAddress(expectedAddress, 'expected emitter')) {
    throw new Error(`Unexpected log emitter ${emitter}`);
  }
  return emitter;
}

function assertTopic(log, expectedTopic, expectedCount) {
  if (!Array.isArray(log?.topics) || log.topics.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} event topics`);
  }
  const topic0 = normalizeTopic(log.topics[0], 'topic0');
  if (topic0 !== expectedTopic) throw new Error(`Unexpected event topic ${topic0}`);
}

function selectQuote(token0, token1, quoteAddresses = [ROBINHOOD_WETH, ROBINHOOD_USDG]) {
  const normalizedToken0 = normalizeAddress(token0, 'token0');
  const normalizedToken1 = normalizeAddress(token1, 'token1');
  const quotes = new Set(quoteAddresses.map((address) => normalizeAddress(address, 'quote address')));
  const token0IsQuote = quotes.has(normalizedToken0);
  const token1IsQuote = quotes.has(normalizedToken1);
  if (token0IsQuote === token1IsQuote) {
    return {
      tracked: false,
      reason: token0IsQuote ? 'ambiguous_quote_pair' : 'unsupported_quote_pair',
    };
  }
  return {
    tracked: true,
    quoteIndex: token0IsQuote ? 0 : 1,
    quoteAddress: token0IsQuote ? normalizedToken0 : normalizedToken1,
    tokenAddress: token0IsQuote ? normalizedToken1 : normalizedToken0,
  };
}

function decodePairCreated(log, options = {}) {
  const factoryAddress = assertEmitter(log, options.factoryAddress || ROBINHOOD_V2_FACTORY);
  assertTopic(log, TOPICS.pairCreated, 3);
  const [pairWord, pairIndexWord] = decodeWords(log.data, 2, 'PairCreated data');
  const token0 = decodeAddressWord(log.topics[1], 'PairCreated token0');
  const token1 = decodeAddressWord(log.topics[2], 'PairCreated token1');
  const pairAddress = decodeAddressWord(pairWord, 'PairCreated pair');
  return {
    kind: 'pair-created',
    ...eventContext(log),
    factoryAddress,
    pairAddress,
    marketKey: `robinhood:uniswap-v2:${pairAddress}`,
    token0,
    token1,
    pairIndex: decodeUint(pairIndexWord).toString(),
    ...selectQuote(token0, token1, options.quoteAddresses),
  };
}

function decodeSwapAmounts(log, pair) {
  assertEmitter(log, pair.pairAddress);
  assertTopic(log, TOPICS.swap, 3);
  const values = decodeWords(log.data, 4, 'Swap data').map(decodeUint);
  return {
    sender: decodeAddressWord(log.topics[1], 'Swap sender'),
    to: decodeAddressWord(log.topics[2], 'Swap to'),
    amount0In: values[0],
    amount1In: values[1],
    amount0Out: values[2],
    amount1Out: values[3],
  };
}

function classifySwap(amounts, pair) {
  const quoteIn = pair.quoteIndex === 0 ? amounts.amount0In : amounts.amount1In;
  const quoteOut = pair.quoteIndex === 0 ? amounts.amount0Out : amounts.amount1Out;
  const tokenIn = pair.quoteIndex === 0 ? amounts.amount1In : amounts.amount0In;
  const tokenOut = pair.quoteIndex === 0 ? amounts.amount1Out : amounts.amount0Out;
  if (quoteIn > 0n && quoteOut === 0n && tokenIn === 0n && tokenOut > 0n) {
    return { accepted: true, side: 'buy', quoteAmountRaw: quoteIn, tokenAmountRaw: tokenOut };
  }
  if (quoteOut > 0n && quoteIn === 0n && tokenIn > 0n && tokenOut === 0n) {
    return { accepted: true, side: 'sell', quoteAmountRaw: quoteOut, tokenAmountRaw: tokenIn };
  }
  return { accepted: false, reason: 'ambiguous_swap_flow' };
}

function decodeSwap(log, pair) {
  if (!pair?.tracked || ![0, 1].includes(pair.quoteIndex)) throw new Error('Tracked pair context is required');
  const amounts = decodeSwapAmounts(log, pair);
  const classified = classifySwap(amounts, pair);
  return {
    kind: 'swap',
    ...eventContext(log),
    poolAddress: pair.pairAddress,
    marketKey: pair.marketKey,
    tokenAddress: pair.tokenAddress,
    quoteAddress: pair.quoteAddress,
    quoteIndex: pair.quoteIndex,
    sender: amounts.sender,
    to: amounts.to,
    amounts: Object.fromEntries(Object.entries(amounts)
      .filter(([, value]) => typeof value === 'bigint')
      .map(([key, value]) => [key, value.toString()])),
    quoteReserveRaw: pair.quoteReserveRaw ?? null,
    tokenReserveRaw: pair.tokenReserveRaw ?? null,
    ...classified,
    ...(classified.accepted ? {
      quoteAmountRaw: classified.quoteAmountRaw.toString(),
      tokenAmountRaw: classified.tokenAmountRaw.toString(),
    } : {}),
  };
}

function decodeSync(log, pair) {
  if (!pair?.tracked || ![0, 1].includes(pair.quoteIndex)) throw new Error('Tracked pair context is required');
  assertEmitter(log, pair.pairAddress);
  assertTopic(log, TOPICS.sync, 1);
  const [reserve0, reserve1] = decodeWords(log.data, 2, 'Sync data').map(decodeUint);
  return {
    kind: 'sync',
    ...eventContext(log),
    poolAddress: pair.pairAddress,
    marketKey: pair.marketKey,
    tokenAddress: pair.tokenAddress,
    quoteAddress: pair.quoteAddress,
    reserve0Raw: reserve0.toString(),
    reserve1Raw: reserve1.toString(),
    quoteReserveRaw: (pair.quoteIndex === 0 ? reserve0 : reserve1).toString(),
    tokenReserveRaw: (pair.quoteIndex === 0 ? reserve1 : reserve0).toString(),
  };
}

function createUniswapV2Tracker(options = {}) {
  const factoryAddress = normalizeAddress(options.factoryAddress || ROBINHOOD_V2_FACTORY);
  const pairs = new Map();
  for (const pair of options.seedPairs || []) {
    const pairAddress = normalizeAddress(pair.pairAddress, 'seed pair address');
    pairs.set(pairAddress, { ...pair, pairAddress, tracked: true });
  }

  function processLog(log) {
    const emitter = normalizeAddress(log?.address, 'log.address');
    const topic0 = normalizeTopic(log?.topics?.[0], 'topic0');
    if (emitter === factoryAddress) {
      if (topic0 !== TOPICS.pairCreated) return { kind: 'ignored', reason: 'unsupported_factory_event' };
      const event = decodePairCreated(log, { ...options, factoryAddress });
      // Sync mutates tracker reserves, never the emitted PairCreated evidence.
      if (event.tracked) pairs.set(event.pairAddress, { ...event });
      return event;
    }
    const pair = pairs.get(emitter);
    if (!pair) return { kind: 'ignored', reason: 'unknown_pair' };
    if (topic0 === TOPICS.swap) return decodeSwap(log, pair);
    if (topic0 === TOPICS.sync) {
      const event = decodeSync(log, pair);
      pair.quoteReserveRaw = event.quoteReserveRaw;
      pair.tokenReserveRaw = event.tokenReserveRaw;
      return event;
    }
    return { kind: 'ignored', reason: 'unsupported_pair_event' };
  }

  return Object.freeze({
    processLog,
    getPair: (address) => pairs.get(normalizeAddress(address)) || null,
    getTrackedPairCount: () => pairs.size,
    getTrackedPairs: () => [...pairs.values()],
    removePair: (address) => pairs.delete(normalizeAddress(address)),
  });
}

module.exports = {
  ROBINHOOD_USDG,
  ROBINHOOD_V2_FACTORY,
  ROBINHOOD_WETH,
  TOPICS,
  classifySwap,
  createUniswapV2Tracker,
  decodePairCreated,
  decodeSwap,
  decodeSync,
  normalizeAddress,
  selectQuote,
};
