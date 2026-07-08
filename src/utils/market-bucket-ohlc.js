const MCAP_LOWER_WICK_OUTLIER_RATIO = 0.65;
const MCAP_UPPER_WICK_OUTLIER_RATIO = 1.35;
const MCAP_FALLBACK_SOURCE = 'gmgn';
const MCAP_FALLBACK_UPPER_WICK_PRIMARY_RATIO = 1.08;
const MCAP_FALLBACK_LOWER_WICK_PRIMARY_RATIO = 0.92;
const MCAP_FALLBACK_CONFIRMED_UPPER_WICK_PRIMARY_RATIO = 1.18;
const MCAP_FALLBACK_CONFIRMED_LOWER_WICK_PRIMARY_RATIO = 0.82;

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

function buildSourceAwareOhlcHighAggregateSql({
  highColumn = 'normalized_high_mcap',
  sourceColumn = 'source',
  primaryHighColumn = 'source_stats.primary_high_mcap',
  primaryCountColumn = 'source_stats.primary_count',
  fallbackCountColumn = 'source_stats.fallback_count',
  fallbackSource = MCAP_FALLBACK_SOURCE,
  fallbackRatio = MCAP_FALLBACK_UPPER_WICK_PRIMARY_RATIO,
  confirmedFallbackRatio = MCAP_FALLBACK_CONFIRMED_UPPER_WICK_PRIMARY_RATIO,
} = {}) {
  return `CASE
           WHEN COALESCE(MAX(${primaryCountColumn}), 0) <= 0 THEN MAX(${highColumn})
           ELSE GREATEST(
             MAX(${primaryHighColumn}),
             COALESCE(
               MAX(${highColumn}) FILTER (
                 WHERE COALESCE(${sourceColumn}, '') = '${fallbackSource}'
                   AND ${primaryHighColumn} > 0
                   AND (
                     ${highColumn} <= ${primaryHighColumn} * ${fallbackRatio}
                     OR (
                       COALESCE(${fallbackCountColumn}, 0) >= 2
                       AND ${highColumn} <= ${primaryHighColumn} * ${confirmedFallbackRatio}
                     )
                   )
               ),
               MAX(${primaryHighColumn})
             )
           )
         END`;
}

function buildSourceAwareOhlcLowAggregateSql({
  lowColumn = 'normalized_low_mcap',
  sourceColumn = 'source',
  primaryLowColumn = 'source_stats.primary_low_mcap',
  primaryCountColumn = 'source_stats.primary_count',
  fallbackCountColumn = 'source_stats.fallback_count',
  fallbackSource = MCAP_FALLBACK_SOURCE,
  fallbackRatio = MCAP_FALLBACK_LOWER_WICK_PRIMARY_RATIO,
  confirmedFallbackRatio = MCAP_FALLBACK_CONFIRMED_LOWER_WICK_PRIMARY_RATIO,
} = {}) {
  return `CASE
           WHEN COALESCE(MAX(${primaryCountColumn}), 0) <= 0 THEN MIN(${lowColumn})
           ELSE LEAST(
             MIN(${primaryLowColumn}),
             COALESCE(
               MIN(${lowColumn}) FILTER (
                 WHERE COALESCE(${sourceColumn}, '') = '${fallbackSource}'
                   AND ${primaryLowColumn} > 0
                   AND (
                     ${lowColumn} >= ${primaryLowColumn} * ${fallbackRatio}
                     OR (
                       COALESCE(${fallbackCountColumn}, 0) >= 2
                       AND ${lowColumn} >= ${primaryLowColumn} * ${confirmedFallbackRatio}
                     )
                   )
               ),
               MIN(${primaryLowColumn})
             )
           )
         END`;
}

module.exports = {
  MCAP_FALLBACK_CONFIRMED_LOWER_WICK_PRIMARY_RATIO,
  MCAP_FALLBACK_CONFIRMED_UPPER_WICK_PRIMARY_RATIO,
  MCAP_FALLBACK_LOWER_WICK_PRIMARY_RATIO,
  MCAP_FALLBACK_SOURCE,
  MCAP_FALLBACK_UPPER_WICK_PRIMARY_RATIO,
  MCAP_LOWER_WICK_OUTLIER_RATIO,
  MCAP_UPPER_WICK_OUTLIER_RATIO,
  buildNormalizedOhlcHighSql,
  buildNormalizedOhlcLowSql,
  buildSourceAwareOhlcHighAggregateSql,
  buildSourceAwareOhlcLowAggregateSql,
  normalizeOhlcHigh,
  normalizeOhlcLow,
};
