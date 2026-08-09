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
// `value` (or legacy `priceUsd`) is the magnitude gated on — pass token-level fdv_usd
// for a token-stable reference. `ceiling` is an absolute hard cap: any value above it
// is always a spike, even the market's first swap and even under recovery (no real
// token approaches it), which catches catastrophic fakes the relative gate can miss.
function evaluatePriceSpike(input) {
  const price = toNumber(input.value ?? input.priceUsd);
  const ref = toNumber(input.reference);
  const consecutiveRejects = Number(input.consecutiveRejects) || 0;
  const k = Number(input.maxMultiple);
  const recover = Math.max(1, Number(input.recoverAfter) || 1);
  const ceiling = toNumber(input.ceiling);

  if (price == null || price <= 0) {
    // Accepted rows are > 0 by constraint; pass through without changing state.
    return { spike: false, reason: null, nextReference: ref, nextConsecutiveRejects: 0 };
  }
  if (ceiling != null && ceiling > 0 && price > ceiling) {
    // Absolute hard cap — unconditional, never becomes the reference.
    return { spike: true, reason: 'above_ceiling', nextReference: ref, nextConsecutiveRejects: consecutiveRejects + 1 };
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
      value: row.value ?? row.priceUsd,
      reference,
      consecutiveRejects,
      maxMultiple: options.maxMultiple,
      recoverAfter: options.recoverAfter,
      ceiling: options.ceiling,
    });
    reference = r.nextReference;
    consecutiveRejects = r.nextConsecutiveRejects;
    return { spike: r.spike, reason: r.reason, recovered: r.recovered === true };
  });
}

// Live guard (dead-pool outlier). A swap in a dead / near-zero-liquidity pool drives
// the token's fdv far ABOVE or BELOW its recent real level (one swap moves an empty
// pool anywhere). `reference` is the token's recent median fdv; a value outside the
// band [reference/k, reference*k] is a candidate outlier. Relative-to-recent on
// purpose: it targets a $0 crash while the token trades at $100M, yet keeps a genuine
// $0 at genesis (when the recent level itself is ~$0).
//
// Volume gate (both directions): an fdv this far off only happens with ~no liquidity,
// and a no-liquidity swap moves ~no value, so its volume is negligible. A REAL fast
// pump/dump moves the same distance but with real volume — so a candidate whose
// `volumeUsd` >= `minVolumeUsd` is a genuine move and is KEPT despite the band.
function evaluateFdvBand(input) {
  const fdv = toNumber(input.fdvUsd);
  const reference = toNumber(input.reference);
  const k = Number(input.maxMultiple);
  if (fdv == null || fdv <= 0 || reference == null || reference <= 0 || !(k > 1)) {
    // No fdv (supply-suppressed), no reference yet, or misconfigured k: cannot judge.
    return { outlier: false, reason: null };
  }
  if (fdv <= k * reference && fdv >= reference / k) {
    return { outlier: false, reason: null };
  }
  const volume = toNumber(input.volumeUsd);
  const minVolume = toNumber(input.minVolumeUsd);
  if (minVolume != null && minVolume > 0 && volume != null && volume >= minVolume) {
    // Out of band but backed by real volume -> a genuine pump/dump, keep it.
    return { outlier: false, reason: null };
  }
  return { outlier: true, reason: 'dead_pool_price' };
}

module.exports = { evaluatePriceSpike, replayMarket, evaluateFdvBand };
