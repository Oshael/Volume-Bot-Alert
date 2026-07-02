const MCAP_LOWER_WICK_OUTLIER_RATIO = 0.65;

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
  buildNormalizedOhlcLowSql,
  normalizeOhlcLow,
};
