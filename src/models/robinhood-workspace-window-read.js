const db = require('./db');
const { MARKET_COVERAGE_CTES } = require('./robinhood-market-coverage-sql');
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
    date_trunc('hour', $2::timestamptz) AS full_hour_end
),
requested AS MATERIALIZED (
  SELECT UNNEST($1::varchar[]) AS token_address
),
raw_windows(window_name, window_start) AS (
  VALUES ('1h', $2::timestamptz - INTERVAL '1 hour'),
    ('6h', $2::timestamptz - INTERVAL '6 hours'),
    ('24h', $2::timestamptz - INTERVAL '24 hours')
),
windows AS MATERIALIZED (
  SELECT window_name, window_start,
    date_trunc('hour', window_start)
      + CASE WHEN window_start = date_trunc('hour', window_start)
        THEN INTERVAL '0 hours' ELSE INTERVAL '1 hour' END AS full_hour_start
  FROM raw_windows
),
${MARKET_COVERAGE_CTES},
canonical_volume_bounds AS (
  SELECT coverage_start_at, coverage_end_at,
    CASE WHEN coverage_end_at IS NULL THEN NULL
      ELSE LEAST(coverage_end_at, $2::timestamptz) END AS volume_window_end
  FROM market_cursor
),
canonical_volume_5m AS MATERIALIZED (
  SELECT requested.token_address,
    canonical_volume_bounds.volume_window_end AS volume_5m_window_end,
    canonical_volume_bounds.volume_window_end - INTERVAL '5 minutes' AS volume_5m_baseline_at,
    CASE
      WHEN canonical_volume_bounds.coverage_start_at IS NULL
        OR canonical_volume_bounds.coverage_end_at IS NULL
        OR canonical_volume_bounds.coverage_end_at <= canonical_volume_bounds.coverage_start_at
        THEN 'unavailable'
      WHEN canonical_volume_bounds.coverage_start_at
          > canonical_volume_bounds.volume_window_end - INTERVAL '10 minutes'
        OR canonical_volume_bounds.coverage_end_at < $2::timestamptz
        THEN 'partial'
      ELSE 'complete'
    END AS volume_5m_delta_coverage,
    SUM(observation.volume_usd) FILTER (
      WHERE observation.observed_at > canonical_volume_bounds.volume_window_end - INTERVAL '5 minutes'
    ) AS current_volume_5m_usd,
    SUM(observation.volume_usd) FILTER (
      WHERE observation.observed_at <= canonical_volume_bounds.volume_window_end - INTERVAL '5 minutes'
    ) AS previous_volume_5m_usd,
    COUNT(*) FILTER (
      WHERE observation.observed_at > canonical_volume_bounds.volume_window_end - INTERVAL '5 minutes'
    ) AS current_swaps_5m
  FROM requested
  LEFT JOIN canonical_volume_bounds ON TRUE
  LEFT JOIN LATERAL (
    SELECT volume_usd, observed_at
    FROM robinhood_market_observations observation
    WHERE observation.chain = 'robinhood'
      AND observation.token_address = requested.token_address
      AND observation.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
      AND observation.status = 'accepted'
      AND observation.observed_at > canonical_volume_bounds.volume_window_end - INTERVAL '10 minutes'
      AND observation.observed_at <= canonical_volume_bounds.volume_window_end
  ) observation ON TRUE
  GROUP BY requested.token_address, canonical_volume_bounds.coverage_start_at,
    canonical_volume_bounds.coverage_end_at, canonical_volume_bounds.volume_window_end
),
full_hour_rows AS MATERIALIZED (
  SELECT windows.window_name, bucket.token_address, bucket.protocol,
    bucket.market_key, bucket.volume_usd, bucket.swaps, bucket.last_observed_at
  FROM requested CROSS JOIN windows CROSS JOIN bounds
  CROSS JOIN LATERAL (
    SELECT bucket.token_address, bucket.protocol, bucket.market_key,
      bucket.volume_usd, bucket.swaps, bucket.last_observed_at
    FROM robinhood_market_buckets_1h bucket
    WHERE bucket.chain = 'robinhood'
      AND bucket.token_address = requested.token_address
      AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
      AND bucket.bucket_ts >= windows.full_hour_start
      AND bucket.bucket_ts < bounds.full_hour_end
    OFFSET 0
  ) bucket
),
start_boundary_rows AS MATERIALIZED (
  SELECT windows.window_name, bucket.token_address, bucket.protocol,
    bucket.market_key, bucket.volume_usd, bucket.swaps, bucket.last_observed_at
  FROM requested CROSS JOIN windows
  CROSS JOIN LATERAL (
    SELECT bucket.token_address, bucket.protocol, bucket.market_key,
      bucket.volume_usd, bucket.swaps, bucket.last_observed_at
    FROM robinhood_market_buckets_1m bucket
    WHERE bucket.chain = 'robinhood'
      AND bucket.token_address = requested.token_address
      AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
      AND bucket.bucket_ts >= windows.window_start
      AND bucket.bucket_ts < windows.full_hour_start
    OFFSET 0
  ) bucket
),
end_boundary_rows AS MATERIALIZED (
  SELECT windows.window_name, bucket.token_address, bucket.protocol,
    bucket.market_key, bucket.volume_usd, bucket.swaps, bucket.last_observed_at
  FROM requested CROSS JOIN bounds
  CROSS JOIN LATERAL (
    SELECT bucket.token_address, bucket.protocol, bucket.market_key,
      bucket.volume_usd, bucket.swaps, bucket.last_observed_at
    FROM robinhood_market_buckets_1m bucket
    WHERE bucket.chain = 'robinhood'
      AND bucket.token_address = requested.token_address
      AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
      AND bucket.bucket_ts >= bounds.full_hour_end
      AND bucket.bucket_ts < bounds.window_end
    OFFSET 0
  ) bucket
  CROSS JOIN windows
),
activity_rows AS MATERIALIZED (
  SELECT * FROM full_hour_rows
  UNION ALL SELECT * FROM start_boundary_rows
  UNION ALL SELECT * FROM end_boundary_rows
),
market_activity AS MATERIALIZED (
  SELECT token_address, protocol, market_key,
    SUM(volume_usd) FILTER (WHERE window_name = '1h') AS volume_1h_usd,
    SUM(volume_usd) FILTER (WHERE window_name = '6h') AS volume_6h_usd,
    SUM(volume_usd) FILTER (WHERE window_name = '24h') AS volume_24h_usd,
    SUM(swaps) FILTER (WHERE window_name = '1h') AS swaps_1h,
    SUM(swaps) FILTER (WHERE window_name = '6h') AS swaps_6h,
    SUM(swaps) FILTER (WHERE window_name = '24h') AS swaps_24h,
    MAX(last_observed_at) FILTER (WHERE window_name = '24h') AS market_last_observed_at
  FROM activity_rows
  GROUP BY token_address, protocol, market_key
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
    SUM(volume_1h_usd) AS volume_1h_usd,
    SUM(volume_6h_usd) AS volume_6h_usd,
    SUM(volume_24h_usd) AS volume_24h_usd,
    SUM(swaps_1h) AS swaps_1h,
    SUM(swaps_6h) AS swaps_6h,
    SUM(swaps_24h) AS swaps_24h,
    MAX(market_last_observed_at) AS last_activity_at
  FROM market_activity
  GROUP BY token_address
),
price_specs(price_window, range_start, target_at, inclusive_target) AS (
  VALUES ('current', $2::timestamptz - INTERVAL '15 minutes', $2::timestamptz, false),
    ('1h', $2::timestamptz - INTERVAL '1 hour 15 minutes',
      $2::timestamptz - INTERVAL '1 hour', true),
    ('6h', $2::timestamptz - INTERVAL '6 hours 15 minutes',
      $2::timestamptz - INTERVAL '6 hours', true),
    ('24h', $2::timestamptz - INTERVAL '24 hours 15 minutes',
      $2::timestamptz - INTERVAL '24 hours', true)
),
price_points AS MATERIALIZED (
  SELECT primary_market.token_address, price_specs.price_window,
    point.close_price_usd, point.last_observed_at
  FROM primary_market CROSS JOIN price_specs
  LEFT JOIN LATERAL (
    SELECT bucket.close_price_usd, bucket.last_observed_at
    FROM robinhood_market_buckets_1m bucket
    WHERE bucket.chain = 'robinhood'
      AND bucket.protocol = primary_market.protocol
      AND bucket.market_key = primary_market.market_key
      AND bucket.bucket_ts >= price_specs.range_start
      AND (bucket.bucket_ts < price_specs.target_at
        OR (price_specs.inclusive_target AND bucket.bucket_ts = price_specs.target_at))
      AND (bucket.last_observed_at < price_specs.target_at
        OR (price_specs.inclusive_target AND bucket.last_observed_at = price_specs.target_at))
    ORDER BY bucket.last_block_number DESC, bucket.last_log_index DESC
    LIMIT 1
  ) point ON TRUE
),
primary_prices AS (
  SELECT token_address,
    MAX(close_price_usd) FILTER (WHERE price_window = 'current') AS current_price_usd,
    MAX(last_observed_at) FILTER (WHERE price_window = 'current') AS current_observed_at,
    MAX(close_price_usd) FILTER (WHERE price_window = '1h') AS price_1h_usd,
    MAX(last_observed_at) FILTER (WHERE price_window = '1h') AS price_1h_observed_at,
    MAX(close_price_usd) FILTER (WHERE price_window = '6h') AS price_6h_usd,
    MAX(last_observed_at) FILTER (WHERE price_window = '6h') AS price_6h_observed_at,
    MAX(close_price_usd) FILTER (WHERE price_window = '24h') AS price_24h_usd,
    MAX(last_observed_at) FILTER (WHERE price_window = '24h') AS price_24h_observed_at
  FROM price_points
  GROUP BY token_address
),
latest_pool_liquidity AS MATERIALIZED (
  SELECT requested.token_address, registry.protocol, registry.market_key,
    registry.pool_address, registry.pool_id, latest.close_liquidity_usd
  FROM requested
  CROSS JOIN bounds
  INNER JOIN robinhood_pool_registry registry
    ON registry.chain = 'robinhood'
   AND registry.token_address = requested.token_address
   AND registry.active = TRUE
  LEFT JOIN LATERAL (
    SELECT bucket.close_liquidity_usd
    FROM robinhood_market_buckets_1h bucket
    WHERE bucket.chain = registry.chain
      AND bucket.protocol = registry.protocol
      AND bucket.market_key = registry.market_key
      AND bucket.bucket_ts >= date_trunc(
        'hour', bounds.window_end - INTERVAL '15 minutes'
      )
      AND bucket.bucket_ts <= date_trunc('hour', bounds.window_end)
      AND bucket.last_observed_at > bounds.window_end - INTERVAL '15 minutes'
      AND bucket.last_observed_at <= bounds.window_end
    ORDER BY bucket.last_observed_at DESC, bucket.last_block_number DESC,
      bucket.last_log_index DESC
    LIMIT 1
  ) latest ON TRUE
),
token_liquidity AS (
  SELECT token_address,
    SUM(close_liquidity_usd) FILTER (WHERE close_liquidity_usd IS NOT NULL)
      AS liquidity_usd,
    COUNT(*)::bigint AS liquidity_market_count,
    COUNT(close_liquidity_usd)::bigint AS valued_liquidity_market_count,
    COALESCE(jsonb_agg(jsonb_build_object(
      'protocol', protocol,
      'marketKey', market_key,
      'poolAddress', pool_address,
      'poolId', pool_id,
      'liquidityUsd', close_liquidity_usd::text
    ) ORDER BY close_liquidity_usd DESC, protocol, market_key)
      FILTER (WHERE close_liquidity_usd IS NOT NULL), '[]'::jsonb) AS liquidity_pools
  FROM latest_pool_liquidity
  GROUP BY token_address
)
SELECT requested.token_address,
  market_cursor.coverage_start_at, market_cursor.coverage_end_at,
  market_cursor.caught_up,
  canonical_volume_5m.current_volume_5m_usd AS volume_5m_usd,
  canonical_volume_5m.previous_volume_5m_usd,
  canonical_volume_5m.volume_5m_baseline_at,
  canonical_volume_5m.volume_5m_window_end,
  canonical_volume_5m.volume_5m_delta_coverage,
  token_activity.volume_1h_usd,
  token_activity.volume_6h_usd, token_activity.volume_24h_usd,
  canonical_volume_5m.current_swaps_5m AS swaps_5m,
  token_activity.swaps_1h,
  token_activity.swaps_6h, token_activity.swaps_24h,
  COALESCE(token_activity.last_activity_at, latest_hour.last_activity_at) AS last_activity_at,
  primary_market.protocol AS primary_protocol,
  primary_market.market_key AS primary_market_key,
  token_liquidity.liquidity_usd,
  COALESCE(token_liquidity.liquidity_market_count, 0) AS liquidity_market_count,
  COALESCE(token_liquidity.valued_liquidity_market_count, 0)
    AS valued_liquidity_market_count,
  COALESCE(token_liquidity.liquidity_pools, '[]'::jsonb) AS liquidity_pools,
  primary_prices.current_price_usd, primary_prices.current_observed_at,
  primary_prices.price_1h_usd, primary_prices.price_1h_observed_at,
  primary_prices.price_6h_usd, primary_prices.price_6h_observed_at,
  primary_prices.price_24h_usd, primary_prices.price_24h_observed_at
FROM requested
CROSS JOIN bounds
LEFT JOIN market_cursor ON TRUE
LEFT JOIN canonical_volume_5m
  ON canonical_volume_5m.token_address = requested.token_address
LEFT JOIN token_activity ON token_activity.token_address = requested.token_address
LEFT JOIN primary_market ON primary_market.token_address = requested.token_address
LEFT JOIN primary_prices ON primary_prices.token_address = requested.token_address
LEFT JOIN token_liquidity ON token_liquidity.token_address = requested.token_address
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

function normalizeCanonicalVolume5m(row) {
  const coverage = String(row.volume_5m_delta_coverage || 'unavailable');
  if (!['complete', 'partial', 'unavailable'].includes(coverage)) {
    throw new Error('volume_5m_delta_coverage is invalid');
  }
  const previous = row.previous_volume_5m_usd == null
    ? (coverage === 'complete' ? 0 : null)
    : Number(row.previous_volume_5m_usd);
  if (previous != null && (!Number.isFinite(previous) || previous < 0)) {
    throw new Error('previous_volume_5m_usd is invalid');
  }
  return {
    prevVolume5mCanonical: coverage === 'unavailable' ? null : previous,
    volume5mBaselineAt: rowTimestamp(row, 'volume_5m_baseline_at'),
    volume5mWindowEnd: rowTimestamp(row, 'volume_5m_window_end'),
    volume5mDeltaCoverage: coverage,
  };
}

function normalizeLiquidity(row) {
  const marketCount = Number(row.liquidity_market_count);
  const valuedMarketCount = Number(row.valued_liquidity_market_count);
  if (!Number.isSafeInteger(marketCount) || marketCount < 0
    || !Number.isSafeInteger(valuedMarketCount) || valuedMarketCount < 0
    || valuedMarketCount > marketCount) {
    throw new Error('Robinhood liquidity market coverage is invalid');
  }
  const liquidityUsd = row.liquidity_usd == null ? null : Number(row.liquidity_usd);
  if (liquidityUsd != null && (!Number.isFinite(liquidityUsd) || liquidityUsd < 0)) {
    throw new Error('Robinhood known liquidity is invalid');
  }
  const liquidityPools = (Array.isArray(row.liquidity_pools) ? row.liquidity_pools : [])
    .map((pool) => {
      const protocol = String(pool?.protocol || '');
      const marketKey = String(pool?.marketKey || '');
      const poolLiquidityUsd = Number(pool?.liquidityUsd);
      if (!['uniswap-v2', 'uniswap-v3', 'uniswap-v4'].includes(protocol)
        || !marketKey || !Number.isFinite(poolLiquidityUsd) || poolLiquidityUsd < 0) {
        throw new Error('Robinhood liquidity pool breakdown is invalid');
      }
      return Object.freeze({
        protocol,
        marketKey,
        poolAddress: pool?.poolAddress == null ? null : String(pool.poolAddress),
        poolId: pool?.poolId == null ? null : String(pool.poolId),
        liquidityUsd: poolLiquidityUsd,
      });
    });
  if (liquidityPools.length !== valuedMarketCount) {
    throw new Error('Robinhood liquidity pool coverage is inconsistent');
  }
  return {
    liquidityUsd,
    liquidityCoverage: valuedMarketCount === 0
      ? 'unavailable'
      : (valuedMarketCount < marketCount ? 'partial' : 'complete'),
    liquidityMarketCount: marketCount,
    valuedLiquidityMarketCount: valuedMarketCount,
    liquidityPools: Object.freeze(liquidityPools),
  };
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
    ...normalizeCanonicalVolume5m(row),
    ...normalizeLiquidity(row),
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
  __private: {
    WINDOW_METRICS_SQL, normalizeAddresses, normalizeCanonicalVolume5m,
    normalizeLiquidity, normalizeRow,
  },
};
