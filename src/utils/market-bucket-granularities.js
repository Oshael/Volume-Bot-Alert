const AGGREGATE_GRANULARITY_MINUTES = Object.freeze([5, 15, 30, 60, 240, 1440]);
const FIVE_MINUTE_AGGREGATE_SOURCE_GRANULARITY = 5;
const ON_WRITE_AGGREGATE_GRANULARITY_MINUTES = Object.freeze([5, 15, 30]);
const ON_WRITE_ROLLUP_AGGREGATE_GRANULARITY_MINUTES = Object.freeze([60, 240, 1440]);
const SPARKLINE_GRANULARITY_MINUTES = Object.freeze([1, ...AGGREGATE_GRANULARITY_MINUTES]);
const MAX_SPARKLINE_GRANULARITY_MINUTES = Math.max(...SPARKLINE_GRANULARITY_MINUTES);
const DEFAULT_SPARKLINE_GRANULARITY_MINUTES = 30;
const ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES = 60;
const MAX_COMPACT_SPARKLINE_POINTS = 500;

function normalizeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function isAggregateGranularityMinutes(value) {
  const parsed = normalizeInteger(value);
  return parsed != null && AGGREGATE_GRANULARITY_MINUTES.includes(parsed);
}

function isSparklineGranularityMinutes(value) {
  const parsed = normalizeInteger(value);
  return parsed != null && SPARKLINE_GRANULARITY_MINUTES.includes(parsed);
}

function normalizeSparklineGranularityMinutes(value) {
  const parsed = normalizeInteger(value);
  return isSparklineGranularityMinutes(parsed)
    ? parsed
    : DEFAULT_SPARKLINE_GRANULARITY_MINUTES;
}

module.exports = {
  AGGREGATE_GRANULARITY_MINUTES,
  ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES,
  DEFAULT_SPARKLINE_GRANULARITY_MINUTES,
  FIVE_MINUTE_AGGREGATE_SOURCE_GRANULARITY,
  MAX_SPARKLINE_GRANULARITY_MINUTES,
  MAX_COMPACT_SPARKLINE_POINTS,
  ON_WRITE_AGGREGATE_GRANULARITY_MINUTES,
  ON_WRITE_ROLLUP_AGGREGATE_GRANULARITY_MINUTES,
  SPARKLINE_GRANULARITY_MINUTES,
  isAggregateGranularityMinutes,
  isSparklineGranularityMinutes,
  normalizeSparklineGranularityMinutes,
};
