const db = require('./db');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const {
  PRICE_CHANGE_WINDOWS,
  WINDOWS,
  buildNormalizedWindowMetrics,
  calculatePriceChange,
  normalizeAsOf,
  resolveBaselineCoverage,
  resolveContinuousCoverage,
} = require('../services/workspace-window-metrics');

const CHAIN = 'robinhood';
const MAX_ADDRESSES = 100;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

const WINDOW_METRICS_SQL = `WITH bounds AS (
  SELECT $2::timestamptz AS window_end,
    $2::timestamptz - INTERVAL '24 hours' AS window_start
),
requested AS MATERIALIZED (
  SELECT UNNEST($1::varchar[]) AS token_address
),
market_cursor AS (
  SELECT coverage_start_timestamp AS coverage_start_at,
    checkpoint_timestamp AS coverage_end_at,
    next_block > safe_head AS caught_up
  FROM robinhood_ingestion_cursors
  WHERE chain = 'robinhood' AND stream = 'market'
),
market_activity AS MATERIALIZED (
  SELECT bucket.token_address, bucket.protocol, bucket.market_key,
    SUM(bucket.volume_usd) FILTER (
      WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '5 minutes') AS volume_5m_usd,
    SUM(bucket.volume_usd) FILTER (
      WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '1 hour') AS volume_1h_usd,
    SUM(bucket.volume_usd) FILTER (
      WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '6 hours') AS volume_6h_usd,
    SUM(bucket.volume_usd) AS volume_24h_usd,
    SUM(bucket.swaps) FILTER (
      WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '5 minutes') AS swaps_5m,
    SUM(bucket.swaps) FILTER (
      WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '1 hour') AS swaps_1h,
    SUM(bucket.swaps) FILTER (
      WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '6 hours') AS swaps_6h,
    SUM(bucket.swaps) AS swaps_24h,
    MAX(bucket.last_observed_at) AS market_last_observed_at
  FROM requested
  INNER JOIN robinhood_market_buckets_1m bucket
    ON bucket.chain = 'robinhood'
   AND bucket.token_address = requested.token_address
   AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
  CROSS JOIN bounds
  WHERE bucket.bucket_ts >= bounds.window_start
    AND bucket.bucket_ts < bounds.window_end
  GROUP BY bucket.token_address, bucket.protocol, bucket.market_key
),
primary_market AS (
  SELECT DISTINCT ON (token_address)
    token_address, protocol, market_key
  FROM market_activity
  ORDER BY token_address, volume_24h_usd DESC, market_last_observed_at DESC,
    protocol ASC, market_key ASC
),
token_activity AS (
  SELECT token_address,
    SUM(volume_5m_usd) AS volume_5m_usd,
    SUM(volume_1h_usd) AS volume_1h_usd,
    SUM(volume_6h_usd) AS volume_6h_usd,
    SUM(volume_24h_usd) AS volume_24h_usd,
    SUM(swaps_5m) AS swaps_5m,
    SUM(swaps_1h) AS swaps_1h,
    SUM(swaps_6h) AS swaps_6h,
    SUM(swaps_24h) AS swaps_24h,
    MAX(market_last_observed_at) AS last_activity_at
  FROM market_activity
  GROUP BY token_address
)
SELECT requested.token_address,
  market_cursor.coverage_start_at, market_cursor.coverage_end_at,
  market_cursor.caught_up,
  token_activity.volume_5m_usd, token_activity.volume_1h_usd,
  token_activity.volume_6h_usd, token_activity.volume_24h_usd,
  token_activity.swaps_5m, token_activity.swaps_1h,
  token_activity.swaps_6h, token_activity.swaps_24h,
  COALESCE(token_activity.last_activity_at, latest_hour.last_activity_at) AS last_activity_at,
  primary_market.protocol AS primary_protocol,
  primary_market.market_key AS primary_market_key,
  prices.current_price_usd, prices.current_observed_at,
  prices.price_1h_usd, prices.price_1h_observed_at,
  prices.price_6h_usd, prices.price_6h_observed_at,
  prices.price_24h_usd, prices.price_24h_observed_at
FROM requested
CROSS JOIN bounds
LEFT JOIN market_cursor ON TRUE
LEFT JOIN token_activity ON token_activity.token_address = requested.token_address
LEFT JOIN primary_market ON primary_market.token_address = requested.token_address
LEFT JOIN LATERAL (
  SELECT bucket.last_observed_at AS last_activity_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood'
    AND bucket.token_address = requested.token_address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.last_observed_at < bounds.window_end
  ORDER BY bucket.bucket_ts DESC, bucket.last_block_number DESC,
    bucket.last_log_index DESC, bucket.protocol ASC, bucket.market_key ASC
  LIMIT 1
) latest_hour ON TRUE
LEFT JOIN LATERAL (
  SELECT
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at < bounds.window_end
        AND bucket.last_observed_at >= bounds.window_end - INTERVAL '15 minutes'))[1]
      AS current_price_usd,
    (array_agg(bucket.last_observed_at ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at < bounds.window_end
        AND bucket.last_observed_at >= bounds.window_end - INTERVAL '15 minutes'))[1]
      AS current_observed_at,
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <= bounds.window_end
        - INTERVAL '1 hour' AND bucket.last_observed_at >= bounds.window_end
        - INTERVAL '1 hour 15 minutes'))[1] AS price_1h_usd,
    (array_agg(bucket.last_observed_at ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <= bounds.window_end
        - INTERVAL '1 hour' AND bucket.last_observed_at >= bounds.window_end
        - INTERVAL '1 hour 15 minutes'))[1] AS price_1h_observed_at,
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <= bounds.window_end
        - INTERVAL '6 hours' AND bucket.last_observed_at >= bounds.window_end
        - INTERVAL '6 hours 15 minutes'))[1] AS price_6h_usd,
    (array_agg(bucket.last_observed_at ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <= bounds.window_end
        - INTERVAL '6 hours' AND bucket.last_observed_at >= bounds.window_end
        - INTERVAL '6 hours 15 minutes'))[1] AS price_6h_observed_at,
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <= bounds.window_end
        - INTERVAL '24 hours' AND bucket.last_observed_at >= bounds.window_end
        - INTERVAL '24 hours 15 minutes'))[1] AS price_24h_usd,
    (array_agg(bucket.last_observed_at ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <= bounds.window_end
        - INTERVAL '24 hours' AND bucket.last_observed_at >= bounds.window_end
        - INTERVAL '24 hours 15 minutes'))[1] AS price_24h_observed_at
  FROM robinhood_market_buckets_1m bucket
  WHERE bucket.chain = 'robinhood'
    AND bucket.token_address = requested.token_address
    AND bucket.protocol = primary_market.protocol
    AND bucket.market_key = primary_market.market_key
    AND bucket.bucket_ts >= bounds.window_end - INTERVAL '24 hours 15 minutes'
    AND bucket.bucket_ts < bounds.window_end
) prices ON TRUE
ORDER BY requested.token_address ASC`;

function normalizeAddresses(values) {
  const addresses = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeTokenAddress(CHAIN, value)))];
  if (addresses.length > MAX_ADDRESSES) {
    throw new Error(`Robinhood workspace metrics accept at most ${MAX_ADDRESSES} addresses`);
  }
  return addresses;
}

function normalizeTimeout(value) {
  const parsed = Number(value ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 60_000) {
    throw new Error('Robinhood workspace metric timeout must be between 1000 and 60000');
  }
  return parsed;
}

function rowTimestamp(row, name) {
  const value = row[name];
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}

function normalizeRow(row, windowEnd) {
  const coverage = Object.fromEntries(WINDOWS.map((window) => [window,
    resolveContinuousCoverage({
      window, windowEnd,
      coverageStartAt: row.coverage_start_at,
      coverageEndAt: row.coverage_end_at,
    })]));
  const currentObservedAt = rowTimestamp(row, 'current_observed_at');
  const priceChanges = {};
  const priceChangeCoverage = {};
  for (const window of PRICE_CHANGE_WINDOWS) {
    const baselineAt = rowTimestamp(row, `price_${window}_observed_at`);
    priceChangeCoverage[window] = resolveBaselineCoverage({
      window, windowEnd, currentObservedAt, baselineObservedAt: baselineAt,
    });
    priceChanges[window] = calculatePriceChange(
      row.current_price_usd, row[`price_${window}_usd`],
    );
  }
  const metrics = buildNormalizedWindowMetrics({
    windowEnd,
    lastActivityAt: rowTimestamp(row, 'last_activity_at'),
    volumes: Object.fromEntries(WINDOWS.map((window) => [window, row[`volume_${window}_usd`]])),
    swaps: Object.fromEntries(WINDOWS.map((window) => [window, row[`swaps_${window}`]])),
    coverage,
    swapCoverage: coverage,
    priceChanges,
    priceChangeCoverage,
  });
  const identity = createTokenIdentity(CHAIN, row.token_address);
  return Object.freeze({
    ...identity,
    ...metrics,
    primaryMarket: row.primary_protocol && row.primary_market_key
      ? Object.freeze({ protocol: row.primary_protocol, marketKey: row.primary_market_key })
      : null,
    coverageProvenance: Object.freeze({
      source: 'robinhood-market-cursor',
      startAt: rowTimestamp(row, 'coverage_start_at'),
      endAt: rowTimestamp(row, 'coverage_end_at'),
      caughtUp: row.caught_up === true,
    }),
  });
}

function createRobinhoodWorkspaceWindowReadRepository(options = {}) {
  const database = options.database || db;
  async function getMetricsByAddresses(input = {}) {
    const addresses = normalizeAddresses(input.addresses);
    const windowEnd = normalizeAsOf(input.asOf == null ? new Date() : input.asOf);
    if (!addresses.length) return Object.freeze([]);
    const timeoutMs = normalizeTimeout(input.statementTimeoutMs);
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, params) => database.queryWithStatementTimeout(sql, params, timeoutMs)
      : (sql, params) => database.query(sql, params);
    const result = await execute(WINDOW_METRICS_SQL, [addresses, windowEnd]);
    return Object.freeze(result.rows.map((row) => normalizeRow(row, windowEnd)));
  }
  return Object.freeze({ getMetricsByAddresses });
}

module.exports = {
  createRobinhoodWorkspaceWindowReadRepository,
  __private: { WINDOW_METRICS_SQL, normalizeAddresses, normalizeRow },
};
