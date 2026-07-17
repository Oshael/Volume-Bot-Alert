const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_BASELINE_STALENESS_MS = 15 * 60 * 1000;

function normalizeText(value) {
  return String(value || '').trim();
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeOptions(options = {}) {
  return {
    windowMs: Math.max(1, toFiniteNumber(options.windowMs, DEFAULT_WINDOW_MS)),
    maxBaselineStalenessMs: Math.max(
      0,
      toFiniteNumber(options.maxBaselineStalenessMs, DEFAULT_MAX_BASELINE_STALENESS_MS),
    ),
  };
}

function normalizeObservation(observation = {}) {
  const price = toFiniteNumber(observation.price);
  const observedAtMs = toFiniteNumber(observation.observedAtMs);
  const normalized = {
    tokenMint: normalizeText(observation.tokenMint),
    signature: normalizeText(observation.signature),
    program: normalizeText(observation.program),
    quoteMint: normalizeText(observation.quoteMint),
    quoteUnit: normalizeText(observation.quoteUnit).toUpperCase(),
    price,
    observedAtMs,
  };
  if (
    observation.accepted !== true
    || !normalized.tokenMint
    || !normalized.signature
    || !normalized.quoteUnit
    || !(price > 0)
    || !(observedAtMs > 0)
  ) {
    return null;
  }
  return normalized;
}

function seriesKey(observation) {
  return `${observation.tokenMint}:${observation.quoteUnit}`;
}

function findBaseline(series, targetAtMs) {
  let baseline = null;
  for (const observation of series) {
    if (observation.observedAtMs > targetAtMs) {
      break;
    }
    baseline = observation;
  }
  return baseline;
}

function computePriceChangePct(currentPrice, baselinePrice) {
  return ((currentPrice / baselinePrice) - 1) * 100;
}

function createOnchainPriceChangeTracker(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const observationsBySeries = new Map();
  const signatures = new Map();

  function prune(nowMs) {
    const cutoffMs = nowMs
      - normalizedOptions.windowMs
      - normalizedOptions.maxBaselineStalenessMs;
    for (const [key, series] of observationsBySeries.entries()) {
      const retained = series.filter((observation) => observation.observedAtMs >= cutoffMs);
      if (retained.length) observationsBySeries.set(key, retained);
      else observationsBySeries.delete(key);
    }
    for (const [signature, observedAtMs] of signatures.entries()) {
      if (observedAtMs < cutoffMs) signatures.delete(signature);
    }
  }

  function add(input) {
    const observation = normalizeObservation(input);
    if (!observation) {
      return { accepted: false, skipReason: 'invalid_price_observation' };
    }
    if (signatures.has(observation.signature)) {
      return { accepted: false, skipReason: 'duplicate_signature' };
    }

    signatures.set(observation.signature, observation.observedAtMs);
    const key = seriesKey(observation);
    const series = observationsBySeries.get(key) || [];
    series.push(observation);
    series.sort((a, b) => a.observedAtMs - b.observedAtMs);
    observationsBySeries.set(key, series);
    const baselineTargetAtMs = observation.observedAtMs - normalizedOptions.windowMs;
    const baseline = findBaseline(observationsBySeries.get(key) || [], baselineTargetAtMs);
    if (!baseline) {
      prune(observation.observedAtMs);
      return { accepted: true, ready: false, reason: 'missing_1h_baseline', observation };
    }

    const baselineStalenessMs = baselineTargetAtMs - baseline.observedAtMs;
    if (baselineStalenessMs > normalizedOptions.maxBaselineStalenessMs) {
      prune(observation.observedAtMs);
      return { accepted: true, ready: false, reason: 'stale_1h_baseline', observation };
    }

    const priceChangePct = computePriceChangePct(observation.price, baseline.price);
    prune(observation.observedAtMs);
    return {
      accepted: true,
      ready: true,
      tokenMint: observation.tokenMint,
      quoteMint: observation.quoteMint,
      quoteUnit: observation.quoteUnit,
      window: '1H',
      windowMs: normalizedOptions.windowMs,
      currentPrice: observation.price,
      baselinePrice: baseline.price,
      currentObservedAtMs: observation.observedAtMs,
      baselineObservedAtMs: baseline.observedAtMs,
      baselineStalenessMs,
      priceChangePct,
      currentPriceChange1h: priceChangePct,
      currentSignature: observation.signature,
      baselineSignature: baseline.signature,
    };
  }

  return {
    add,
    prune,
    size: () => [...observationsBySeries.values()].reduce((sum, series) => sum + series.length, 0),
  };
}

module.exports = {
  DEFAULT_MAX_BASELINE_STALENESS_MS,
  DEFAULT_WINDOW_MS,
  computePriceChangePct,
  createOnchainPriceChangeTracker,
  __private: {
    findBaseline,
    normalizeObservation,
    normalizeOptions,
    seriesKey,
  },
};
