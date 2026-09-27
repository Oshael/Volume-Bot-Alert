const { formatDecimal, multiply, parseDecimal, rational } = require('./evm-market-metrics');
const { scoreOpenWalletPosition } = require('./robinhood-wallet-ranking-domain');

const WINDOW_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  ALL: null,
});
const EXACT_COST_QUALITIES = new Set(['exact_swap_only', 'transfer_adjusted']);
const RELIABLE_QUANTITY_QUALITIES = new Set([
  'exact_swap_only', 'transfer_adjusted', 'transferred_assumed_zero',
]);
const IN_TYPES = new Set(['buy', 'transfer_in']);
const OUT_TYPES = new Set(['sell', 'transfer_out']);

function nonNegativeRaw(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(text);
}

function normalizedInput(input) {
  if (!Object.hasOwn(WINDOW_MS, input.window)) throw new Error('window is invalid');
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime())) throw new Error('asOf is invalid');
  const tokenDecimals = Number(input.tokenDecimals);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255) {
    throw new Error('tokenDecimals must be uint8');
  }
  const quantityRaw = nonNegativeRaw(input.quantityRaw, 'quantityRaw');
  const windowStart = WINDOW_MS[input.window] == null
    ? null : new Date(asOf.getTime() - WINDOW_MS[input.window]);
  return { asOf, windowStart, tokenDecimals, quantityRaw };
}

function partialScore(quantityRaw, reasons, knownGainUsd = null) {
  return {
    eligible: quantityRaw > 0n,
    gainUsd: null,
    knownGainUsd,
    openQuantityRaw: quantityRaw.toString(),
    coverage: 'partial',
    reasons: [...new Set(reasons)].sort(),
  };
}

function scoreAll(input, normalized) {
  const { quantityRaw, tokenDecimals } = normalized;
  const reasons = [];
  if (input.projectionAligned !== true) reasons.push('projection_unaligned');
  if (!EXACT_COST_QUALITIES.has(input.quality)) reasons.push('cost_basis_unavailable');
  const price = input.currentPriceUsd == null
    ? null : parseDecimal(input.currentPriceUsd, 'currentPriceUsd');
  if (price == null) reasons.push('current_price_unavailable');
  else if (price.numerator <= 0n) throw new Error('currentPriceUsd must be positive');
  const basis = input.costBasisUsd == null
    ? null : parseDecimal(input.costBasisUsd, 'costBasisUsd');
  if (basis == null) reasons.push('cost_basis_unavailable');
  else if (basis.numerator < 0n) throw new Error('costBasisUsd must be non-negative');
  if (quantityRaw === 0n) {
    return { eligible: false, gainUsd: null, knownGainUsd: null,
      openQuantityRaw: '0', coverage: reasons.length ? 'partial' : 'complete',
      reasons: [...new Set(reasons)].sort() };
  }
  if (reasons.length) return partialScore(quantityRaw, reasons);
  const value = multiply(rational(quantityRaw, 10n ** BigInt(tokenDecimals)), price);
  const gain = rational(
    value.numerator * basis.denominator - basis.numerator * value.denominator,
    value.denominator * basis.denominator,
  );
  const gainUsd = formatDecimal(gain, 36);
  return { eligible: true, gainUsd, knownGainUsd: gainUsd,
    openQuantityRaw: quantityRaw.toString(), coverage: 'complete', reasons: [] };
}

function windowEvents(input, normalized) {
  if (!Array.isArray(input.events)) throw new Error('events must be a list');
  let delta = 0n;
  for (const event of input.events) {
    const time = new Date(event.time);
    if (!Number.isFinite(time.getTime()) || time < normalized.windowStart || time > normalized.asOf) {
      throw new Error('event is outside the ranking window');
    }
    const amount = nonNegativeRaw(event.amountRaw, 'event amountRaw');
    if (amount === 0n) throw new Error('event amountRaw must be positive');
    if (IN_TYPES.has(event.type)) delta += amount;
    else if (OUT_TYPES.has(event.type)) delta -= amount;
    else throw new Error('event type is invalid');
  }
  return delta;
}

function scoreWindow(input, normalized) {
  const { quantityRaw, windowStart, tokenDecimals } = normalized;
  const delta = windowEvents(input, normalized);
  const opening = quantityRaw - delta;
  if (opening < 0n) return partialScore(quantityRaw, ['snapshot_event_mismatch']);
  const reasons = [];
  if (input.projectionAligned !== true) reasons.push('projection_unaligned');
  if (input.eventsComplete !== true) reasons.push('window_events_incomplete');
  if (!RELIABLE_QUANTITY_QUALITIES.has(input.quality)) {
    reasons.push('position_quality_unreliable');
  }
  let openingCost = null;
  if (opening > 0n && input.windowStartPriceUsd != null) {
    const price = parseDecimal(input.windowStartPriceUsd, 'windowStartPriceUsd');
    if (price.numerator <= 0n) throw new Error('windowStartPriceUsd must be positive');
    openingCost = formatDecimal(multiply(
      rational(opening, 10n ** BigInt(tokenDecimals)), price,
    ), 36);
  }
  const synthetic = opening > 0n ? [{ type: 'buy', time: windowStart,
    amountRaw: opening.toString(), volumeUsd: openingCost }] : [];
  const scored = scoreOpenWalletPosition({
    asOf: normalized.asOf, windowStart, tokenDecimals,
    currentPriceUsd: input.currentPriceUsd,
    windowStartPriceUsd: input.windowStartPriceUsd,
    historyComplete: reasons.length === 0,
    events: [...synthetic, ...input.events],
  });
  if (scored.openQuantityRaw !== quantityRaw.toString()) reasons.push('snapshot_event_mismatch');
  const sourceComplete = reasons.length === 0 && !scored.reasons.includes('unmatched_outflow');
  reasons.push(...scored.reasons);
  if (reasons.length) {
    return partialScore(quantityRaw, reasons, sourceComplete ? scored.knownGainUsd : null);
  }
  return scored;
}

function scoreOpenWalletPositionSnapshot(input = {}) {
  const normalized = normalizedInput(input);
  return normalized.windowStart == null
    ? scoreAll(input, normalized) : scoreWindow(input, normalized);
}

module.exports = { scoreOpenWalletPositionSnapshot };
