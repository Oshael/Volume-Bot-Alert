const Q96 = 1n << 96n;
const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;
const RATIOS = Object.freeze([
  0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
]);

function sqrtRatioAtTick(value) {
  const tick = Number(value);
  if (!Number.isInteger(tick) || Math.abs(tick) > MAX_TICK) throw new Error('V4 tick is out of range');
  const absolute = Math.abs(tick);
  let ratio = (absolute & 1) ? RATIOS[0] : (1n << 128n);
  for (let bit = 1; bit < RATIOS.length; bit += 1) {
    if (absolute & (1 << bit)) ratio = (ratio * RATIOS[bit]) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  const remainder = ratio & ((1n << 32n) - 1n);
  return (ratio >> 32n) + (remainder === 0n ? 0n : 1n);
}

function rangeAmounts(liquidity, lower, upper, current) {
  if (current <= lower) {
    return { amount0: liquidity * (upper - lower) * Q96 / (upper * lower), amount1: 0n };
  }
  if (current < upper) {
    return {
      amount0: liquidity * (upper - current) * Q96 / (upper * current),
      amount1: liquidity * (current - lower) / Q96,
    };
  }
  return { amount0: 0n, amount1: liquidity * (upper - lower) / Q96 };
}

function poolAmounts(sqrtPriceX96, ranges) {
  const current = BigInt(sqrtPriceX96);
  if (current <= 0n || !Array.isArray(ranges)) throw new Error('Invalid V4 liquidity inputs');
  return ranges.reduce((total, row) => {
    const liquidity = BigInt(row.liquidity_gross ?? row.liquidityGross);
    if (liquidity < 0n) throw new Error('V4 range liquidity cannot be negative');
    const amounts = rangeAmounts(
      liquidity,
      sqrtRatioAtTick(row.tick_lower ?? row.tickLower),
      sqrtRatioAtTick(row.tick_upper ?? row.tickUpper),
      current
    );
    return { amount0: total.amount0 + amounts.amount0, amount1: total.amount1 + amounts.amount1 };
  }, { amount0: 0n, amount1: 0n });
}

function mergeRangeDeltas(ranges, deltas = []) {
  const merged = new Map(ranges.map((row) => {
    const lower = Number(row.tick_lower ?? row.tickLower);
    const upper = Number(row.tick_upper ?? row.tickUpper);
    return [`${lower}:${upper}`, { tickLower: lower, tickUpper: upper, liquidityGross: BigInt(row.liquidity_gross ?? row.liquidityGross) }];
  }));
  for (const delta of deltas) {
    const key = `${delta.tickLower}:${delta.tickUpper}`;
    const row = merged.get(key) || { tickLower: delta.tickLower, tickUpper: delta.tickUpper, liquidityGross: 0n };
    row.liquidityGross += BigInt(delta.liquidityDelta);
    // An over-removal (a remove whose matching add predates our coverage or was
    // pruned) would drive gross negative. Isolate that range at zero — the filter
    // below drops it — instead of halting the whole batch/cursor.
    if (row.liquidityGross < 0n) row.liquidityGross = 0n;
    merged.set(key, row);
  }
  return [...merged.values()].filter((row) => row.liquidityGross > 0n);
}

module.exports = { MAX_TICK, mergeRangeDeltas, poolAmounts, sqrtRatioAtTick };
