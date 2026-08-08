'use strict';

// Pure, stateless per-observation decision. The CALLER keeps, per market, a running
// `reference` (last accepted price_usd) and a `consecutiveRejects` counter.
//
// Why: a swap in a dead / near-zero-liquidity pool drives the pool price to an
// economically-meaningless extreme. That value is an ISOLATED spike relative to the
// market's recent accepted price, so we reject it and it never poisons bucket
// high/low. A GENUINE sustained move keeps exceeding the gate; after `recoverAfter`
// consecutive rejects we accept and re-anchor, so real moves recover within a few
// swaps instead of being suppressed forever.

function toNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Returns { spike, reason, nextReference, nextConsecutiveRejects, recovered }.
function evaluatePriceSpike(input) {
  const price = toNumber(input.priceUsd);
  const ref = toNumber(input.reference);
  const consecutiveRejects = Number(input.consecutiveRejects) || 0;
  const k = Number(input.maxMultiple);
  const recover = Math.max(1, Number(input.recoverAfter) || 1);

  if (price == null || price <= 0) {
    // Accepted rows are > 0 by constraint; pass through without changing state.
    return { spike: false, reason: null, nextReference: ref, nextConsecutiveRejects: 0 };
  }
  if (ref == null || ref <= 0) {
    // First observation of the market: nothing to compare, bootstrap the reference.
    return { spike: false, reason: null, nextReference: price, nextConsecutiveRejects: 0 };
  }
  const ratio = price / ref;
  if (ratio <= k && ratio >= 1 / k) {
    // Within the band: accept and advance the reference.
    return { spike: false, reason: null, nextReference: price, nextConsecutiveRejects: 0 };
  }
  if (consecutiveRejects + 1 >= recover) {
    // Sustained move (kept exceeding the gate): accept and re-anchor to the new level.
    return { spike: false, reason: null, nextReference: price, nextConsecutiveRejects: 0, recovered: true };
  }
  // Isolated spike: reject, keep the reference where it was.
  return { spike: true, reason: 'dead_pool_price', nextReference: ref, nextConsecutiveRejects: consecutiveRejects + 1 };
}

// Replay a time-ordered sequence for ONE market. `prices` = [{ priceUsd }, ...] in
// on-chain order. Returns a parallel array of { spike, reason, recovered }.
function replayMarket(prices, options) {
  let reference = null;
  let consecutiveRejects = 0;
  return prices.map((row) => {
    const r = evaluatePriceSpike({
      priceUsd: row.priceUsd,
      reference,
      consecutiveRejects,
      maxMultiple: options.maxMultiple,
      recoverAfter: options.recoverAfter,
    });
    reference = r.nextReference;
    consecutiveRejects = r.nextConsecutiveRejects;
    return { spike: r.spike, reason: r.reason, recovered: r.recovered === true };
  });
}

module.exports = { evaluatePriceSpike, replayMarket };
