const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  MAX_TICK,
  mergeRangeDeltas,
  poolAmounts,
  sqrtRatioAtTick,
} = require('../src/services/uniswap-v4-liquidity');

describe('Uniswap V4 liquidity math', () => {
  it('matches canonical TickMath boundaries and tick zero', () => {
    assert.equal(sqrtRatioAtTick(-MAX_TICK), 4295128739n);
    assert.equal(sqrtRatioAtTick(0), 1n << 96n);
    assert.equal(
      sqrtRatioAtTick(MAX_TICK),
      1461446703485210103287273052203988822378723970342n
    );
  });

  it('distributes principal across both currencies at the current tick', () => {
    const amounts = poolAmounts(1n << 96n, [{
      tickLower: -60,
      tickUpper: 60,
      liquidityGross: 10n ** 18n,
    }]);

    assert.ok(amounts.amount0 > 0n);
    assert.ok(amounts.amount1 > 0n);
    assert.ok(amounts.amount0 - amounts.amount1 <= 1n);
  });

  it('merges pending live deltas without allowing negative liquidity', () => {
    const merged = mergeRangeDeltas(
      [{ tick_lower: -60, tick_upper: 60, liquidity_gross: '100' }],
      [{ tickLower: -60, tickUpper: 60, liquidityDelta: '-40' }]
    );
    assert.equal(merged[0].liquidityGross, 60n);
    // An over-removal isolates that range at zero and drops it, rather than
    // halting the whole batch (which previously froze the market cursor).
    assert.deepEqual(mergeRangeDeltas(merged, [{
      tickLower: -60, tickUpper: 60, liquidityDelta: '-61',
    }]), []);
  });
});
