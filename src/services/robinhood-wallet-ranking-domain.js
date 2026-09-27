const { formatDecimal, multiply, parseDecimal, rational } = require('./evm-market-metrics');

const PLACES = 36;
const EVENT_TYPES = new Set(['buy', 'sell', 'transfer_in', 'transfer_out']);

function add(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left, right) {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function positiveDecimal(value, label) {
  if (value == null) return null;
  const result = parseDecimal(value, label);
  if (result.numerator <= 0n) throw new Error(`${label} must be positive`);
  return result;
}

function timestamp(value, label) {
  if (value == null || value === '') throw new Error(`${label} is invalid`);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`${label} is invalid`);
  return result.getTime();
}

function rawAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw new Error('event amountRaw must be a positive integer');
  }
  return rational(BigInt(text));
}

function normalizeEvent(event, asOfMs) {
  if (!EVENT_TYPES.has(event?.type)) throw new Error('event type is invalid');
  const timeMs = timestamp(event.time, 'event time');
  if (timeMs > asOfMs) throw new Error('event time is after asOf');
  return {
    type: event.type,
    timeMs,
    amount: rawAmount(event.amountRaw),
    volume: event.type === 'buy'
      ? positiveDecimal(event.volumeUsd, 'buy volumeUsd') : null,
  };
}

function scaleOpenLots(lots, quantity) {
  const total = lots.reduce((sum, lot) => add(sum, lot.quantity), rational(0n));
  if (total.numerator === 0n) return false;
  const removed = quantity.numerator * total.denominator >= total.numerator * quantity.denominator
    ? total : quantity;
  const factor = subtract(rational(1n), rational(
    removed.numerator * total.denominator,
    removed.denominator * total.numerator,
  ));
  for (const lot of lots) {
    lot.quantity = multiply(lot.quantity, factor);
    if (lot.basis != null) lot.basis = multiply(lot.basis, factor);
  }
  return quantity.numerator * total.denominator <= total.numerator * quantity.denominator;
}

function basisForBuy(event, windowStartMs, windowStartPrice, scale) {
  if (windowStartMs == null || event.timeMs >= windowStartMs) return event.volume;
  return windowStartPrice == null
    ? null : multiply(event.amount, rational(1n, scale), windowStartPrice);
}

function addEventLot(lots, event, windowStartMs, windowStartPrice, scale) {
  lots.push({
    quantity: event.amount,
    basis: event.type === 'buy'
      ? basisForBuy(event, windowStartMs, windowStartPrice, scale) : null,
    source: event.type,
  });
}

function normalizeScoreInput(input) {
  const asOfMs = timestamp(input.asOf, 'asOf');
  const windowStartMs = input.windowStart == null
    ? null : timestamp(input.windowStart, 'windowStart');
  if (windowStartMs != null && windowStartMs >= asOfMs) {
    throw new Error('windowStart must precede asOf');
  }
  const decimals = Number(input.tokenDecimals);
  if (input.tokenDecimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('tokenDecimals must be uint8');
  }
  const scale = 10n ** BigInt(decimals);
  const currentPrice = positiveDecimal(input.currentPriceUsd, 'currentPriceUsd');
  const windowStartPrice = windowStartMs == null ? null
    : positiveDecimal(input.windowStartPriceUsd, 'windowStartPriceUsd');
  const events = (input.events || []).map((event) => normalizeEvent(event, asOfMs));
  if (events.some((event, index) => index > 0 && event.timeMs < events[index - 1].timeMs)) {
    throw new Error('events must be in canonical chronological order');
  }
  return { windowStartMs, scale, currentPrice, windowStartPrice, events };
}

function buildOpenLots(input, normalized) {
  const lots = [];
  const reasons = new Set();
  if (input.historyComplete !== true) reasons.add('incomplete_history');
  for (const event of normalized.events) {
    if (event.type === 'buy' || event.type === 'transfer_in') {
      addEventLot(lots, event, normalized.windowStartMs, normalized.windowStartPrice, normalized.scale);
    } else if (!scaleOpenLots(lots, event.amount)) {
      reasons.add('unmatched_outflow');
    }
  }
  return { lots: lots.filter((lot) => lot.quantity.numerator > 0n), reasons };
}

function sumKnownGain(lots, currentPrice, scale, reasons) {
  let knownGain = rational(0n);
  for (const lot of lots) {
    if (lot.basis == null) {
      reasons.add(lot.source === 'transfer_in' ? 'transfer_cost_unknown' : 'basis_unavailable');
      continue;
    }
    if (currentPrice != null) {
      const currentValue = multiply(lot.quantity, rational(1n, scale), currentPrice);
      knownGain = add(knownGain, subtract(currentValue, lot.basis));
    }
  }
  return currentPrice == null ? null : formatDecimal(knownGain, PLACES);
}

function scoreOpenWalletPosition(input = {}) {
  const normalized = normalizeScoreInput(input);
  const { lots, reasons } = buildOpenLots(input, normalized);
  const openQuantity = lots.reduce((sum, lot) => add(sum, lot.quantity), rational(0n));
  if (!lots.length) {
    return Object.freeze({ eligible: false, gainUsd: null, knownGainUsd: null,
      openQuantityRaw: '0', coverage: reasons.size ? 'partial' : 'complete',
      reasons: Object.freeze([...reasons]) });
  }
  if (normalized.currentPrice == null) reasons.add('current_price_unavailable');
  const knownGainUsd = sumKnownGain(lots, normalized.currentPrice, normalized.scale, reasons);
  return Object.freeze({
    eligible: true,
    gainUsd: reasons.size ? null : knownGainUsd,
    knownGainUsd,
    openQuantityRaw: formatDecimal(openQuantity, 0),
    coverage: reasons.size ? 'partial' : 'complete',
    reasons: Object.freeze([...reasons]),
  });
}

module.exports = { scoreOpenWalletPosition };
