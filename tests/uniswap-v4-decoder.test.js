const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fixture = require('../data/fixtures/robinhood-uniswap-v4.json');
const {
  DYNAMIC_FEE_FLAG,
  NATIVE_CURRENCY,
  Q192,
  ROBINHOOD_USDG,
  ROBINHOOD_V4_POOL_MANAGER,
  ROBINHOOD_WETH,
  TOPICS,
  createUniswapV4Tracker,
  decodeInitialize,
  decodeModifyLiquidity,
  decodeSwap,
  selectQuote,
} = require('../src/services/uniswap-v4-decoder');

const MEME_LOW = '0x0000000000000000000000000000000000000001';
const MEME_HIGH = '0xffffffffffffffffffffffffffffffffffffffff';
const HOOK = '0x1111111111111111111111111111111111111111';
const SENDER = '0x2222222222222222222222222222222222222222';
const POOL_ID = `0x${'33'.repeat(32)}`;
const OTHER_POOL_ID = `0x${'44'.repeat(32)}`;
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
    address: ROBINHOOD_V4_POOL_MANAGER,
    topics: [TOPICS.initialize, POOL_ID, addressWord(MEME_LOW), addressWord(ROBINHOOD_WETH)],
    data: dataWords(uintWord(3000), intWord(60), addressWord(NATIVE_CURRENCY), uintWord(1n << 96n), intWord(0)),
    blockNumber: '0x64',
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: '0x0',
    blockTimestamp: '0x10',
    removed: false,
    ...overrides,
  };
}

function initializeLog(currency0, currency1, values = {}) {
  return baseLog({
    topics: [TOPICS.initialize, values.poolId || POOL_ID, addressWord(currency0), addressWord(currency1)],
    data: dataWords(
      uintWord(values.fee ?? 3000),
      intWord(values.tickSpacing ?? 60),
      addressWord(values.hooks || NATIVE_CURRENCY),
      uintWord(values.sqrtPriceX96 ?? (1n << 96n)),
      intWord(values.tick ?? 0)
    ),
  });
}

function swapLog(values = {}) {
  return baseLog({
    topics: [TOPICS.swap, values.poolId || POOL_ID, addressWord(values.sender || SENDER)],
    data: dataWords(
      intWord(values.amount0 ?? 1),
      intWord(values.amount1 ?? -1),
      uintWord(values.sqrtPriceX96 ?? (1n << 96n)),
      uintWord(values.liquidity ?? 1000),
      intWord(values.tick ?? 0),
      uintWord(values.fee ?? 3000)
    ),
  });
}

function modifyLiquidityLog(values = {}) {
  return baseLog({
    topics: [TOPICS.modifyLiquidity, values.poolId || POOL_ID, addressWord(values.sender || SENDER)],
    data: dataWords(
      intWord(values.tickLower ?? -120),
      intWord(values.tickUpper ?? 120),
      intWord(values.liquidityDelta ?? 500),
      values.salt || uintWord(9)
    ),
  });
}

describe('Robinhood Uniswap v4 decoder', () => {
  it('decodes a real Initialize into a poolId keyed USDG market', () => {
    const pool = decodeInitialize(fixture.initialize);
    const squared = BigInt(fixture.expected.initializeSqrtPriceX96) ** 2n;

    assert.equal(pool.kind, 'initialize');
    assert.equal(pool.poolAddress, null);
    assert.equal(pool.poolId, fixture.expected.poolId);
    assert.equal(pool.marketKey, `robinhood:uniswap-v4:${fixture.expected.poolId}`);
    assert.equal(pool.currency0, fixture.expected.currency0);
    assert.equal(pool.currency1, fixture.expected.currency1);
    assert.equal(pool.tokenAddress, fixture.expected.currency0);
    assert.equal(pool.quoteAddress, ROBINHOOD_USDG);
    assert.equal(pool.fee, fixture.expected.fee);
    assert.equal(pool.dynamicFee, false);
    assert.equal(pool.tickSpacing, fixture.expected.tickSpacing);
    assert.equal(pool.hooksAddress, fixture.expected.hooks);
    assert.equal(pool.sqrtPriceX96, fixture.expected.initializeSqrtPriceX96);
    assert.equal(pool.tick, fixture.expected.initializeTick);
    assert.equal(pool.priceQuotePerTokenRaw.numerator, squared.toString());
    assert.equal(pool.priceQuotePerTokenRaw.denominator, Q192.toString());
  });

  it('decodes the real Swap and classifies pool deltas from the token perspective', () => {
    const tracker = createUniswapV4Tracker();
    tracker.processLog(fixture.initialize);
    const swap = tracker.processLog(fixture.swap);

    assert.equal(swap.kind, 'swap');
    assert.equal(swap.poolId, fixture.expected.poolId);
    assert.equal(swap.poolAddress, null);
    assert.equal(swap.accepted, true);
    assert.equal(swap.side, fixture.expected.side);
    assert.equal(swap.amount0, fixture.expected.amount0);
    assert.equal(swap.amount1, fixture.expected.amount1);
    assert.equal(swap.quoteAmountRaw, fixture.expected.quoteAmountRaw);
    assert.equal(swap.tokenAmountRaw, fixture.expected.tokenAmountRaw);
    assert.equal(swap.sqrtPriceX96, fixture.expected.swapSqrtPriceX96);
    assert.equal(swap.liquidityRaw, fixture.expected.liquidity);
    assert.equal(swap.tick, fixture.expected.swapTick);
    assert.equal(swap.fee, fixture.expected.fee);
  });

  it('registers pools by poolId although every event has the same emitter', () => {
    const tracker = createUniswapV4Tracker();
    const pool = tracker.processLog(initializeLog(MEME_LOW, ROBINHOOD_WETH));
    const swap = tracker.processLog(swapLog({ amount0: -12, amount1: 3 }));

    assert.equal(tracker.getPool(POOL_ID), pool);
    assert.equal(tracker.getTrackedPools().length, 1);
    assert.equal(swap.side, 'buy');
    assert.equal(swap.quoteAmountRaw, '3');
    assert.equal(swap.tokenAmountRaw, '12');
  });

  it('decodes signed ModifyLiquidity deltas for an exact tick range', () => {
    const tracker = createUniswapV4Tracker();
    const pool = tracker.processLog(initializeLog(MEME_LOW, ROBINHOOD_WETH));
    const added = tracker.processLog(modifyLiquidityLog());
    const removed = decodeModifyLiquidity(modifyLiquidityLog({
      liquidityDelta: -125,
      salt: uintWord(10),
    }), pool);

    assert.equal(added.kind, 'modify-liquidity');
    assert.equal(added.poolId, POOL_ID);
    assert.equal(added.sender, SENDER);
    assert.equal(added.tickLower, -120);
    assert.equal(added.tickUpper, 120);
    assert.equal(added.liquidityDelta, '500');
    assert.equal(removed.liquidityDelta, '-125');
    assert.equal(removed.salt, uintWord(10));
  });

  it('treats native ETH explicitly while using WETH as its canonical quote asset', () => {
    const selected = selectQuote(NATIVE_CURRENCY, MEME_HIGH);
    const pool = decodeInitialize(initializeLog(NATIVE_CURRENCY, MEME_HIGH));

    assert.equal(selected.quoteIndex, 0);
    assert.equal(selected.quoteCurrencyAddress, NATIVE_CURRENCY);
    assert.equal(selected.quoteAddress, ROBINHOOD_WETH);
    assert.equal(selected.quoteKind, 'native');
    assert.equal(pool.quoteCurrencyAddress, NATIVE_CURRENCY);
    assert.equal(pool.quoteAddress, ROBINHOOD_WETH);
  });

  it('records hooks and dynamic fee flags as context without changing classification', () => {
    const pool = decodeInitialize(initializeLog(MEME_LOW, ROBINHOOD_WETH, {
      fee: DYNAMIC_FEE_FLAG,
      hooks: HOOK,
    }));
    const swap = decodeSwap(swapLog({ amount0: -8, amount1: 2 }), pool);

    assert.equal(pool.dynamicFee, true);
    assert.equal(pool.hooksAddress, HOOK);
    assert.equal(swap.side, 'buy');
    assert.equal('hooksResult' in swap, false);
  });

  it('does not register unsupported or ambiguous quote pools', () => {
    const tracker = createUniswapV4Tracker();
    assert.equal(selectQuote(MEME_LOW, MEME_HIGH).reason, 'unsupported_quote_pool');
    assert.equal(selectQuote(ROBINHOOD_WETH, ROBINHOOD_USDG).reason, 'ambiguous_quote_pool');
    assert.equal(selectQuote(NATIVE_CURRENCY, ROBINHOOD_WETH).reason, 'ambiguous_quote_pool');
    assert.equal(tracker.processLog(initializeLog(MEME_LOW, MEME_HIGH)).tracked, false);
    assert.equal(tracker.getTrackedPools().length, 0);
  });

  it('rejects ambiguous deltas rather than inventing volume or side', () => {
    const pool = decodeInitialize(initializeLog(MEME_LOW, ROBINHOOD_WETH));
    const swap = decodeSwap(swapLog({ amount0: 1, amount1: 2 }), pool);

    assert.equal(swap.accepted, false);
    assert.equal(swap.reason, 'ambiguous_swap_deltas');
    assert.equal('side' in swap, false);
    assert.equal('quoteAmountRaw' in swap, false);
  });

  it('ignores unknown poolIds, emitters and PoolManager event types', () => {
    const tracker = createUniswapV4Tracker();
    tracker.processLog(initializeLog(MEME_LOW, ROBINHOOD_WETH));

    assert.equal(tracker.processLog(swapLog({ poolId: OTHER_POOL_ID })).reason, 'unknown_pool');
    assert.equal(tracker.processLog(baseLog({ address: MEME_HIGH })).reason, 'unexpected_emitter');
    assert.equal(tracker.processLog(baseLog({ topics: [`0x${'55'.repeat(32)}`] })).reason,
      'unsupported_pool_manager_event');
  });

  it('fails closed for mismatched pool context and malformed matching ABI', () => {
    const pool = decodeInitialize(initializeLog(MEME_LOW, ROBINHOOD_WETH));

    assert.throws(() => decodeSwap(swapLog({ poolId: OTHER_POOL_ID }), pool), /does not match/);
    assert.throws(() => decodeSwap({ ...swapLog(), data: '0x00' }, pool), /exactly 6 ABI words/);
    assert.throws(() => decodeInitialize({ ...baseLog(), data: '0x00' }), /exactly 5 ABI words/);
    assert.throws(() => decodeInitialize(initializeLog(MEME_LOW, ROBINHOOD_WETH, {
      tickSpacing: 0,
    })), /must be positive/);
    assert.throws(() => decodeSwap(swapLog({ amount0: 1n << 127n }), pool), /exceeds int128/);
    assert.throws(
      () => decodeModifyLiquidity(modifyLiquidityLog({ tickLower: -119 }), pool),
      /align with pool tickSpacing/
    );
    assert.throws(
      () => decodeModifyLiquidity(modifyLiquidityLog({ tickLower: 120, tickUpper: 60 }), pool),
      /range must be increasing/
    );
    assert.throws(() => decodeInitialize(initializeLog(MEME_LOW, ROBINHOOD_WETH, {
      fee: 1n << 24n,
    })), /exceeds uint24/);
    assert.throws(() => decodeSwap(swapLog({ sqrtPriceX96: 1n << 160n }), pool), /exceeds uint160/);
    assert.throws(() => decodeInitialize({ ...baseLog(), address: MEME_HIGH }), /Unexpected log emitter/);
  });
});
