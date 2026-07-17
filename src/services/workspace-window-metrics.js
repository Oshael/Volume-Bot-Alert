const MINUTE_MS = 60 * 1000;
const DEFAULT_SNAPSHOT_ALIGNMENT_MS = MINUTE_MS;
const DEFAULT_BASELINE_TOLERANCE_MS = 15 * MINUTE_MS;

const WINDOW_MS = Object.freeze({
  '5m': 5 * MINUTE_MS,
  '1h': 60 * MINUTE_MS,
  '6h': 6 * 60 * MINUTE_MS,
  '24h': 24 * 60 * MINUTE_MS,
});
const WINDOWS = Object.freeze(Object.keys(WINDOW_MS));
const PRICE_CHANGE_WINDOWS = Object.freeze(['1h', '6h', '24h']);
const COVERAGE_STATES = new Set(['complete', 'partial', 'unavailable']);
const FIELD_SUFFIX = Object.freeze({ '5m': '5m', '1h': '1h', '6h': '6h', '24h': '24h' });

function parseTimestamp(value, label, nullable = false) {
  if ((value == null || value === '') && nullable) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

function normalizeAsOf(value = new Date()) {
  const parsed = parseTimestamp(value, 'asOf');
  parsed.setUTCSeconds(0, 0);
  return parsed;
}

function normalizeWindow(value) {
  const window = String(value || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(WINDOW_MS, window)) {
    throw new Error(`Unsupported workspace metric window: ${window || 'empty'}`);
  }
  return window;
}

function normalizeCoverage(value) {
  const coverage = String(value || 'unavailable').trim().toLowerCase();
  if (!COVERAGE_STATES.has(coverage)) throw new Error(`Invalid metric coverage: ${coverage}`);
  return coverage;
}

function hasMetricValue(value) {
  return value != null && value !== '';
}

function metricNumber(value, label, options = {}) {
  if (!hasMetricValue(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (!options.signed && parsed < 0)) {
    throw new Error(`${label} is invalid`);
  }
  if (options.count && !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is outside safe integer range`);
  }
  return parsed;
}

function normalizeMetric(value, coverageValue, label, options = {}) {
  const coverage = normalizeCoverage(coverageValue);
  if (coverage === 'unavailable') return null;
  const parsed = metricNumber(value, label, options);
  if (parsed != null) return parsed;
  return coverage === 'complete' ? 0 : null;
}

function windowBounds(windowValue, windowEndValue) {
  const window = normalizeWindow(windowValue);
  const windowEnd = normalizeAsOf(windowEndValue);
  return {
    window,
    windowEnd,
    windowStart: new Date(windowEnd.getTime() - WINDOW_MS[window]),
  };
}

function resolveContinuousCoverage(input = {}) {
  const bounds = windowBounds(input.window, input.windowEnd);
  const coverageStart = parseTimestamp(input.coverageStartAt, 'coverageStartAt', true);
  const coverageEnd = parseTimestamp(input.coverageEndAt, 'coverageEndAt', true);
  if (!coverageStart || !coverageEnd || coverageEnd <= coverageStart) return 'unavailable';
  if (coverageEnd <= bounds.windowStart || coverageStart >= bounds.windowEnd) {
    return 'unavailable';
  }
  return coverageStart <= bounds.windowStart && coverageEnd >= bounds.windowEnd
    ? 'complete'
    : 'partial';
}

function resolveSnapshotCoverage(input = {}) {
  if (!hasMetricValue(input.value)) return 'unavailable';
  const bounds = windowBounds(input.window, input.windowEnd);
  const observedAt = parseTimestamp(input.observedAt, 'observedAt', true);
  if (!observedAt || observedAt > bounds.windowEnd) return 'unavailable';
  const alignmentMs = Number(input.alignmentMs ?? DEFAULT_SNAPSHOT_ALIGNMENT_MS);
  if (!Number.isFinite(alignmentMs) || alignmentMs < 0) {
    throw new Error('snapshot alignment is invalid');
  }
  if (bounds.windowEnd.getTime() - observedAt.getTime() > alignmentMs) return 'partial';

  if (input.requiresWindowHistory === true) {
    const historyStart = parseTimestamp(input.historyStartAt, 'historyStartAt', true);
    if (!historyStart || historyStart > bounds.windowStart) return 'partial';
  }
  return 'complete';
}

function resolveBaselineCoverage(input = {}) {
  const bounds = windowBounds(input.window, input.windowEnd);
  const currentAt = parseTimestamp(input.currentObservedAt, 'currentObservedAt', true);
  const baselineAt = parseTimestamp(input.baselineObservedAt, 'baselineObservedAt', true);
  if (!currentAt || !baselineAt) return 'unavailable';
  const toleranceMs = Number(input.toleranceMs ?? DEFAULT_BASELINE_TOLERANCE_MS);
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new Error('baseline tolerance is invalid');
  }
  const currentAgeMs = bounds.windowEnd.getTime() - currentAt.getTime();
  const baselineAgeMs = bounds.windowStart.getTime() - baselineAt.getTime();
  if (currentAgeMs < 0 || baselineAgeMs < 0) return 'unavailable';
  return currentAgeMs <= toleranceMs && baselineAgeMs <= toleranceMs
    ? 'complete'
    : 'partial';
}

function calculatePriceChange(currentValue, baselineValue) {
  const current = metricNumber(currentValue, 'current price');
  const baseline = metricNumber(baselineValue, 'baseline price');
  if (current == null || baseline == null || current <= 0 || baseline <= 0) return null;
  return ((current / baseline) - 1) * 100;
}

function normalizeLastActivity(value, windowEnd) {
  const parsed = parseTimestamp(value, 'lastActivityAt', true);
  if (!parsed) return null;
  if (parsed > windowEnd) throw new Error('lastActivityAt cannot be after windowEnd');
  return parsed.toISOString();
}

function buildNormalizedWindowMetrics(input = {}) {
  const windowEnd = normalizeAsOf(input.windowEnd || input.asOf || new Date());
  const output = {
    windowEnd: windowEnd.toISOString(),
    lastActivityAt: normalizeLastActivity(input.lastActivityAt, windowEnd),
  };
  const coverage = {};
  const swapCoverage = {};
  const priceChangeCoverage = {};

  for (const window of WINDOWS) {
    coverage[window] = normalizeCoverage(input.coverage?.[window]);
    swapCoverage[window] = normalizeCoverage(input.swapCoverage?.[window]);
    const suffix = FIELD_SUFFIX[window];
    output[`volume${suffix}Usd`] = normalizeMetric(
      input.volumes?.[window], coverage[window], `${window} volume`,
    );
    output[`swaps${suffix}`] = normalizeMetric(
      input.swaps?.[window], swapCoverage[window], `${window} swaps`, { count: true },
    );
  }

  for (const window of PRICE_CHANGE_WINDOWS) {
    priceChangeCoverage[window] = normalizeCoverage(input.priceChangeCoverage?.[window]);
    output[`priceChange${FIELD_SUFFIX[window]}Pct`] = priceChangeCoverage[window] === 'complete'
      ? metricNumber(input.priceChanges?.[window], `${window} price change`, { signed: true })
      : null;
  }

  output.coverage = Object.freeze(coverage);
  output.swapCoverage = Object.freeze(swapCoverage);
  output.priceChangeCoverage = Object.freeze(priceChangeCoverage);
  return Object.freeze(output);
}

module.exports = {
  DEFAULT_BASELINE_TOLERANCE_MS,
  DEFAULT_SNAPSHOT_ALIGNMENT_MS,
  PRICE_CHANGE_WINDOWS,
  WINDOWS,
  WINDOW_MS,
  buildNormalizedWindowMetrics,
  calculatePriceChange,
  normalizeAsOf,
  resolveBaselineCoverage,
  resolveContinuousCoverage,
  resolveSnapshotCoverage,
};
