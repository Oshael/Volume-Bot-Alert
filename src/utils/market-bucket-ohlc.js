const MCAP_LOWER_WICK_OUTLIER_RATIO = 0.65;
const MCAP_UPPER_WICK_OUTLIER_RATIO = 1.35;

function toFiniteNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOhlcLow({ open, low, close, outlierRatio = MCAP_LOWER_WICK_OUTLIER_RATIO } = {}) {
  const openValue = toFiniteNumberOrNull(open);
  const lowValue = toFiniteNumberOrNull(low);
  const closeValue = toFiniteNumberOrNull(close);
  if (lowValue == null) {
    return null;
  }
  if (!(openValue > 0) || !(closeValue > 0)) {
    return lowValue;
  }

  const bodyLow = Math.min(openValue, closeValue);
  return lowValue <= 0 || lowValue < bodyLow * outlierRatio ? bodyLow : lowValue;
}

function normalizeOhlcHigh({ open, high, close, outlierRatio = MCAP_UPPER_WICK_OUTLIER_RATIO } = {}) {
  const openValue = toFiniteNumberOrNull(open);
  const highValue = toFiniteNumberOrNull(high);
  const closeValue = toFiniteNumberOrNull(close);
  if (highValue == null) {
    return null;
  }
  if (!(openValue > 0) || !(closeValue > 0)) {
    return highValue;
  }

  const bodyHigh = Math.max(openValue, closeValue);
  return highValue <= 0 || highValue > bodyHigh * outlierRatio ? bodyHigh : highValue;
}

function buildNormalizedOhlcHighSql({
  openColumn = 'open_mcap',
  highColumn = 'high_mcap',
  closeColumn = 'close_mcap',
  outlierRatio = MCAP_UPPER_WICK_OUTLIER_RATIO,
} = {}) {
  return `CASE
           WHEN ${openColumn} > 0
            AND ${closeColumn} > 0
            AND (
              ${highColumn} <= 0
              OR ${highColumn} > GREATEST(${openColumn}, ${closeColumn}) * ${outlierRatio}
            )
             THEN GREATEST(${openColumn}, ${closeColumn})
           ELSE ${highColumn}
         END`;
}

function buildNormalizedOhlcLowSql({
  openColumn = 'open_mcap',
  lowColumn = 'low_mcap',
  closeColumn = 'close_mcap',
  outlierRatio = MCAP_LOWER_WICK_OUTLIER_RATIO,
} = {}) {
  return `CASE
           WHEN ${openColumn} > 0
            AND ${closeColumn} > 0
            AND (
              ${lowColumn} <= 0
              OR ${lowColumn} < LEAST(${openColumn}, ${closeColumn}) * ${outlierRatio}
            )
             THEN LEAST(${openColumn}, ${closeColumn})
           ELSE ${lowColumn}
         END`;
}

module.exports = {
  MCAP_LOWER_WICK_OUTLIER_RATIO,
  MCAP_UPPER_WICK_OUTLIER_RATIO,
  buildNormalizedOhlcHighSql,
  buildNormalizedOhlcLowSql,
  normalizeOhlcHigh,
  normalizeOhlcLow,
};
