const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const {
  Q192,
  ROBINHOOD_USDG,
  ROBINHOOD_V3_FACTORY,
  ROBINHOOD_WETH,
  TOPICS,
  createUniswapV3Tracker,
  decodeInt,
  decodePoolCreated,
  decodeSwap,
  exactPriceRatio,
  selectQuote,
} = require('../src/services/uniswap-v3-decoder');

const MEME_LOW = '0x0000000000000000000000000000000000000001';
const MEME_HIGH = '0xffffffffffffffffffffffffffffffffffffffff';
const POOL = '0x1111111111111111111111111111111111111111';
const SENDER = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const TX_HASH = `0x${'bb'.repeat(32)}`;

function uintWord(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function intWord(value) {
  const number = BigInt(value);
  return uintWord(number < 0n ? (1n << 256n) + number : number);
}

function addressWord(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function dataWords(...values) {
  return `0x${values.map((value) => value.slice(2)).join('')}`;
}

function baseLog(overrides = {}) {
  return {
    address: POOL,
    topics: [TOPICS.initialize],
    data: dataWords(uintWord(1n << 96n), intWord(0)),
    blockNumber: '0x64',
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: '0x0',
    blockTimestamp: '0x10',
    removed: false,
    ...overrides,
  };
}

function poolCreatedLog(token0, token1, options = {}) {
  return baseLog({
    address: ROBINHOOD_V3_FACTORY,
    topics: [
      TOPICS.poolCreated,
      addressWord(token0),
      addressWord(token1),
      uintWord(options.fee ?? 3000),
    ],
    data: dataWords(intWord(options.tickSpacing ?? 60), addressWord(options.pool || POOL)),
  });
}

function swapLog(pool, values = {}) {
  return baseLog({
    address: pool,
    topics: [TOPICS.swap, addressWord(SENDER), addressWord(RECIPIENT)],
    data: dataWords(
      intWord(values.amount0 ?? 1),
      intWord(values.amount1 ?? -1),
      uintWord(values.sqrtPriceX96 ?? (1n << 96n)),
      uintWord(values.liquidity ?? 1000),
      intWord(values.tick ?? 0)
    ),
  });
}

describe('Robinhood Uniswap v3 decoder', () => {
  it('discovers the real WETH pool with fee and tick spacing', () => {
    const pool = decodePoolCreated(fixture.poolCreated);

    assert.equal(pool.kind, 'pool-created');
    assert.equal(pool.factoryAddress, fixture.factory);
    assert.equal(pool.token0, fixture.expected.token0);
    assert.equal(pool.token1, fixture.expected.token1);
    assert.equal(pool.poolAddress, fixture.expected.pool);
    assert.equal(pool.marketKey, `robinhood:uniswap-v3:${fixture.expected.pool}`);
    assert.equal(pool.fee, fixture.expected.fee);
    assert.equal(pool.tickSpacing, fixture.expected.tickSpacing);
    assert.equal(pool.quoteIndex, 0);
    assert.equal(pool.quoteAddress, ROBINHOOD_WETH);
    assert.equal(pool.tracked, true);
  });

  it('decodes the real Initialize and keeps sqrtPriceX96 as an exact ratio', () => {
    const tracker = createUniswapV3Tracker();
    const pool = tracker.processLog(fixture.poolCreated);
    const initialized = tracker.processLog(fixture.initialize);
    const squared = BigInt(fixture.expected.initializeSqrtPriceX96) ** 2n;

    assert.equal(tracker.getPool(fixture.expected.pool), pool);
    assert.equal(initialized.kind, 'initialize');
    assert.equal(initialized.sqrtPriceX96, fixture.expected.initializeSqrtPriceX96);
    assert.equal(initialized.tick, fixture.expected.initializeTick);
    assert.equal(initialized.priceQuotePerTokenRaw.numerator, Q192.toString());
    assert.equal(initialized.priceQuotePerTokenRaw.denominator, squared.toString());
  });

  it('translates the real signed deltas into a WETH buy with exact volume', () => {
    const tracker = createUniswapV3Tracker();
    tracker.processLog(fixture.poolCreated);
    const swap = tracker.processLog(fixture.swap);

    assert.equal(swap.kind, 'swap');
    assert.equal(swap.marketKey, `robinhood:uniswap-v3:${fixture.expected.pool}`);
    assert.equal(swap.accepted, true);
    assert.equal(swap.amount0, fixture.expected.amount0);
    assert.equal(swap.amount1, fixture.expected.amount1);
    assert.equal(swap.side, fixture.expected.side);
    assert.equal(swap.quoteAmountRaw, fixture.expected.quoteAmountRaw);
    assert.equal(swap.tokenAmountRaw, fixture.expected.tokenAmountRaw);
    assert.equal(swap.sqrtPriceX96, fixture.expected.swapSqrtPriceX96);
    assert.equal(swap.liquidityRaw, fixture.expected.liquidity);
    assert.equal(swap.tick, fixture.expected.swapTick);
  });

  it('handles a sell when the quote token is token1', () => {
    const tracker = createUniswapV3Tracker();
    const pool = tracker.processLog(poolCreatedLog(MEME_LOW, ROBINHOOD_WETH));
    const swap = tracker.processLog(swapLog(POOL, { amount0: 123, amount1: -7 }));

    assert.equal(pool.quoteIndex, 1);
    assert.equal(swap.accepted, true);
    assert.equal(swap.side, 'sell');
    assert.equal(swap.tokenAmountRaw, '123');
    assert.equal(swap.quoteAmountRaw, '7');
  });

  it('supports USDG and normalizes direct checksum/casing inputs', () => {
    const tracker = createUniswapV3Tracker();
    const pool = tracker.processLog(poolCreatedLog(MEME_LOW, ROBINHOOD_USDG));
    const swap = tracker.processLog(swapLog(POOL, { amount0: -50, amount1: 25 }));

    assert.equal(pool.quoteAddress, ROBINHOOD_USDG);
    assert.equal(swap.side, 'buy');
    assert.equal(swap.quoteAmountRaw, '25');
    assert.equal(selectQuote(MEME_LOW.toUpperCase(), ROBINHOOD_USDG.toUpperCase()).quoteAddress, ROBINHOOD_USDG);
  });

  it('does not track pools with no quote or two canonical quotes', () => {
    assert.equal(selectQuote(MEME_LOW, MEME_HIGH).reason, 'unsupported_quote_pool');
    assert.equal(selectQuote(ROBINHOOD_WETH, ROBINHOOD_USDG).reason, 'ambiguous_quote_pool');
    const tracker = createUniswapV3Tracker();
    assert.equal(tracker.processLog(poolCreatedLog(MEME_LOW, MEME_HIGH)).tracked, false);
    assert.equal(tracker.getTrackedPools().length, 0);
  });

  it('rejects ambiguous signed deltas instead of inventing side or volume', () => {
    const tracker = createUniswapV3Tracker();
    tracker.processLog(poolCreatedLog(ROBINHOOD_WETH, MEME_HIGH));
    const swap = tracker.processLog(swapLog(POOL, { amount0: 10, amount1: 5 }));

    assert.equal(swap.accepted, false);
    assert.equal(swap.reason, 'ambiguous_swap_deltas');
    assert.equal('side' in swap, false);
    assert.equal('quoteAmountRaw' in swap, false);
  });

  it('inverts the exact sqrt ratio only according to quote position', () => {
    const sqrtPriceX96 = (1n << 96n) * 3n;
    const token1Quote = exactPriceRatio(sqrtPriceX96, { quoteIndex: 1 });
    const token0Quote = exactPriceRatio(sqrtPriceX96, { quoteIndex: 0 });

    assert.equal(BigInt(token1Quote.numerator), sqrtPriceX96 ** 2n);
    assert.equal(BigInt(token1Quote.denominator), Q192);
    assert.equal(BigInt(token0Quote.numerator), Q192);
    assert.equal(BigInt(token0Quote.denominator), sqrtPriceX96 ** 2n);
    assert.throws(() => exactPriceRatio(0n, { quoteIndex: 0 }), /must be positive/);
  });

  it('decodes sign-extended int24 and rejects out-of-range ABI values', () => {
    assert.equal(decodeInt(intWord(-887272), 24, 'tick'), -887272n);
    assert.throws(() => decodeInt(uintWord(1n << 23n), 24, 'tick'), /exceeds int24/);

    const pool = decodePoolCreated(poolCreatedLog(ROBINHOOD_WETH, MEME_HIGH));
    const oversizedSqrt = 1n << 160n;
    assert.throws(
      () => decodeSwap(swapLog(POOL, { sqrtPriceX96: oversizedSqrt }), pool),
      /exceeds uint160/
    );
  });

  it('ignores unknown emitters/topics and fails closed for malformed matching ABI', () => {
    const tracker = createUniswapV3Tracker();
    tracker.processLog(poolCreatedLog(ROBINHOOD_WETH, MEME_HIGH));

    assert.equal(tracker.processLog(swapLog(MEME_HIGH)).reason, 'unknown_pool');
    assert.equal(tracker.processLog(baseLog({ address: POOL, topics: [`0x${'44'.repeat(32)}`] })).reason,
      'unsupported_pool_event');
    const pool = decodePoolCreated(poolCreatedLog(ROBINHOOD_WETH, MEME_HIGH));
    assert.throws(() => decodeSwap({ ...swapLog(POOL), data: '0x00' }, pool), /exactly 5 ABI words/);
    assert.throws(() => decodePoolCreated({ ...poolCreatedLog(ROBINHOOD_WETH, MEME_HIGH),
      address: MEME_HIGH }), /Unexpected log emitter/);
  });
});
