const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  MAX_CATALOG_FDV_USD,
} = require('../services/robinhood-catalog-fdv-policy');

const CHAIN = 'robinhood';
const MINUTE_MS = 60 * 1000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const FRESH_MS = 15 * MINUTE_MS;

const ACTIVE_CATALOG_ROWS_SQL = `WITH bounds AS (
  SELECT $1::timestamptz AS window_end,
    $1::timestamptz - INTERVAL '15 minutes' AS freshness_start
),
recent AS MATERIALIZED (
  SELECT bucket.token_address,
    MAX(bucket.last_observed_at) AS recent_last_observed_at,
    MIN(registry.discovered_at) AS discovered_at,
    COALESCE(SUM(bucket.volume_usd) FILTER (
      WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '5 minutes'), 0)
      AS volume_5m_usd,
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.close_price_usd IS NOT NULL))[1]
      AS last_price_usd,
    (array_agg(bucket.close_fdv_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.close_fdv_usd IS NOT NULL))[1]
      AS last_fdv_usd
  FROM robinhood_market_buckets_1m bucket
  INNER JOIN robinhood_pool_registry registry
    ON registry.chain = bucket.chain
   AND registry.protocol = bucket.protocol
   AND registry.market_key = bucket.market_key
   AND registry.token_address = bucket.token_address
   AND registry.quote_address = bucket.quote_address
   AND registry.active = TRUE
  CROSS JOIN bounds
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= date_trunc('minute', bounds.freshness_start)
    AND bucket.bucket_ts < bounds.window_end
  GROUP BY bucket.token_address, bounds.window_end, bounds.freshness_start
  HAVING MAX(bucket.last_observed_at) > bounds.freshness_start
)
SELECT
  'robinhood'::varchar AS chain,
  recent.token_address AS address,
  catalog.symbol,
  catalog.name,
  TRUE AS eligible_for_monitoring,
  NULL::numeric AS last_mcap,
  COALESCE(recent.last_fdv_usd, catalog.last_fdv) AS last_fdv,
  COALESCE(recent.last_price_usd, catalog.last_price) AS last_price,
  NULL::numeric AS last_liquidity_usd,
  recent.volume_5m_usd AS last_vol_5m,
  catalog.last_vol_1h,
  catalog.last_vol_6h,
  catalog.last_vol_24h,
  catalog.last_price_change_1h,
  catalog.last_price_change_6h,
  catalog.last_price_change_24h,
  COALESCE(catalog.last_token_created_at_ms,
    EXTRACT(EPOCH FROM recent.discovered_at) * 1000) AS last_token_created_at_ms,
  catalog.last_pair_address,
  catalog.last_pair_url,
  catalog.last_dex_id,
  catalog.last_image_url,
  catalog.last_twitter_url,
  catalog.last_community_url,
  'active'::varchar AS monitor_priority,
  COALESCE(catalog.first_seen_at, recent.discovered_at) AS first_seen_at,
  recent.recent_last_observed_at AS last_seen_at,
  catalog.last_evaluated_at
FROM recent
LEFT JOIN token_catalog catalog
  ON catalog.chain = 'robinhood' AND catalog.address = recent.token_address
WHERE COALESCE(recent.last_fdv_usd, catalog.last_fdv, 0) >= $2
  AND COALESCE(recent.last_fdv_usd, catalog.last_fdv, 0) < ${MAX_CATALOG_FDV_USD}
  AND NOT EXISTS (
    SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'robinhood' AND blocked.address = recent.token_address
  )
ORDER BY recent.volume_5m_usd DESC, recent.recent_last_observed_at DESC,
  recent.token_address ASC`;

const DASHBOARD_PAGE_SQL = `WITH bounds AS (
  SELECT $1::timestamptz AS window_end,
    $1::timestamptz - INTERVAL '24 hours' AS window_start,
    $1::timestamptz - INTERVAL '15 minutes' AS freshness_start,
    date_trunc('hour', $1::timestamptz) - INTERVAL '23 hours' AS rank_start,
    date_trunc('hour', $1::timestamptz) + INTERVAL '1 hour' AS rank_end
),
recent_tokens AS MATERIALIZED (
  SELECT bucket.token_address, MAX(bucket.last_observed_at) AS recent_last_observed_at
  FROM robinhood_market_buckets_1m bucket CROSS JOIN bounds
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= date_trunc('minute', bounds.freshness_start)
    AND bucket.bucket_ts < bounds.window_end
  GROUP BY bucket.token_address
),
market_24h AS MATERIALIZED (
  SELECT bucket.protocol, bucket.market_key, bucket.token_address,
    bucket.quote_address, recent.recent_last_observed_at,
    SUM(bucket.volume_usd) AS volume_24h_usd,
    SUM(bucket.swaps)::bigint AS swaps_24h, SUM(bucket.buys)::bigint AS buys_24h,
    SUM(bucket.sells)::bigint AS sells_24h,
    SUM(bucket.transactions)::bigint AS transactions_24h,
    MIN(bucket.first_observed_at) AS first_observed_at,
    MAX(bucket.last_observed_at) AS last_observed_at,
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC))[1] AS last_price_usd,
    (array_agg(bucket.close_fdv_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC))[1] AS last_fdv_usd,
    (array_agg(bucket.close_liquidity_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC))[1] AS last_liquidity_usd,
    (array_agg(bucket.close_liquidity_status ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC))[1] AS last_liquidity_status,
    (array_agg(bucket.close_liquidity_confidence ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC))[1] AS last_liquidity_confidence,
    (array_agg(bucket.close_liquidity_warning ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC))[1] AS last_liquidity_warning
  FROM recent_tokens recent CROSS JOIN LATERAL (
    SELECT hourly.* FROM robinhood_market_buckets_1h hourly, bounds
    WHERE hourly.chain = 'robinhood' AND hourly.token_address = recent.token_address
      AND hourly.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
      AND hourly.bucket_ts >= bounds.rank_start AND hourly.bucket_ts < bounds.rank_end
    OFFSET 0
  ) bucket
  GROUP BY bucket.protocol, bucket.market_key, bucket.token_address,
    bucket.quote_address, recent.recent_last_observed_at
),
active_markets AS MATERIALIZED (
  SELECT market.*, registry.discovered_at
  FROM market_24h market
  INNER JOIN robinhood_pool_registry registry
    ON registry.chain = 'robinhood' AND registry.protocol = market.protocol
   AND registry.market_key = market.market_key
   AND registry.token_address = market.token_address
   AND registry.quote_address = market.quote_address AND registry.active = true
),
ranked AS (
  SELECT market.*,
    SUM(volume_24h_usd) OVER token AS token_volume_24h_usd,
    SUM(swaps_24h) OVER token AS token_swaps_24h,
    SUM(buys_24h) OVER token AS token_buys_24h,
    SUM(sells_24h) OVER token AS token_sells_24h,
    SUM(transactions_24h) OVER token AS token_transactions_24h,
    SUM(last_liquidity_usd) OVER token AS token_liquidity_usd,
    COUNT(*) OVER token AS token_market_count,
    COUNT(*) FILTER (WHERE last_liquidity_usd IS NULL)
      OVER token AS incomplete_liquidity_markets,
    MIN(discovered_at) OVER token AS token_discovered_at,
    MIN(first_observed_at) OVER token AS token_first_observed_at,
    MAX(recent_last_observed_at) OVER token AS token_last_observed_at,
    ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY
      volume_24h_usd DESC, last_observed_at DESC, protocol ASC, market_key ASC
    ) AS primary_rank
  FROM active_markets market
  WINDOW token AS (PARTITION BY token_address)
),
page AS MATERIALIZED (
  SELECT ranked.* FROM ranked CROSS JOIN bounds
  WHERE primary_rank = 1
    AND token_last_observed_at > bounds.freshness_start
    AND (last_fdv_usd IS NULL OR last_fdv_usd < ${MAX_CATALOG_FDV_USD})
    AND NOT EXISTS (
      SELECT 1 FROM admin_blocked_tokens blocked
      WHERE blocked.chain = 'robinhood' AND blocked.address = ranked.token_address
    )
    AND ($3::numeric IS NULL OR token_volume_24h_usd < $3::numeric
      OR (token_volume_24h_usd = $3::numeric AND token_last_observed_at < $4::timestamptz)
      OR (token_volume_24h_usd = $3::numeric AND token_last_observed_at = $4::timestamptz
        AND token_address > $5::varchar))
  ORDER BY token_volume_24h_usd DESC, token_last_observed_at DESC, token_address ASC
  LIMIT $2::int
),
exact_metrics AS MATERIALIZED (
  SELECT page.token_address,
    COALESCE(SUM(metrics.volume_5m_usd), 0) AS volume_5m_usd,
    COALESCE(SUM(metrics.volume_1h_usd), 0) AS volume_1h_usd,
    COALESCE(SUM(metrics.volume_6h_usd), 0) AS volume_6h_usd
  FROM page INNER JOIN active_markets market
    ON market.token_address = page.token_address
  JOIN LATERAL (
    SELECT
      COALESCE(SUM(bucket.volume_usd) FILTER (
        WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '5 minutes'), 0)
        AS volume_5m_usd,
      COALESCE(SUM(bucket.volume_usd) FILTER (
        WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '1 hour'), 0)
        AS volume_1h_usd,
      COALESCE(SUM(bucket.volume_usd) FILTER (
        WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '6 hours'), 0)
        AS volume_6h_usd
    FROM robinhood_market_buckets_1m bucket, bounds
    WHERE bucket.chain = 'robinhood' AND bucket.protocol = market.protocol
      AND bucket.market_key = market.market_key
      AND bucket.bucket_ts >= bounds.window_end - INTERVAL '6 hours'
      AND bucket.bucket_ts < bounds.window_end
  ) metrics ON true
  GROUP BY page.token_address
)
SELECT page.*, metrics.volume_5m_usd, metrics.volume_1h_usd,
  metrics.volume_6h_usd, page.token_volume_24h_usd AS exact_volume_24h_usd,
  page.token_swaps_24h AS exact_swaps_24h,
  page.token_transactions_24h AS exact_transactions_24h,
  baseline_1h.price_usd AS price_1h_usd,
  baseline_6h.price_usd AS price_6h_usd,
  baseline_24h.price_usd AS price_24h_usd,
  COALESCE((SELECT jsonb_object_agg(contribution.protocol,
    jsonb_build_object('volumeUsd', contribution.volume_usd::text,
      'swaps', contribution.swaps::text, 'transactions', contribution.transactions::text,
      'markets', contribution.markets::text) ORDER BY contribution.protocol)
    FROM (SELECT protocol, SUM(volume_24h_usd) AS volume_usd,
      SUM(swaps_24h) AS swaps, SUM(transactions_24h) AS transactions, COUNT(*) AS markets
      FROM active_markets WHERE token_address = page.token_address GROUP BY protocol
    ) contribution), '{}'::jsonb) AS protocol_breakdown,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('protocol', market.protocol,
    'marketKey', market.market_key, 'quoteAddress', market.quote_address,
    'volumeUsd', market.volume_24h_usd::text, 'swaps', market.swaps_24h::text,
    'transactions', market.transactions_24h::text,
    'lastObservedAt', market.last_observed_at) ORDER BY market.volume_24h_usd DESC,
      market.last_observed_at DESC, market.protocol ASC, market.market_key ASC)
    FROM active_markets market WHERE market.token_address = page.token_address),
    '[]'::jsonb) AS market_breakdown
FROM page
INNER JOIN exact_metrics metrics ON metrics.token_address = page.token_address
LEFT JOIN LATERAL (
  SELECT close_price_usd AS price_usd FROM robinhood_market_buckets_1m bucket, bounds
  WHERE bucket.chain = 'robinhood' AND bucket.protocol = page.protocol
    AND bucket.market_key = page.market_key
    AND bucket.bucket_ts <= bounds.window_end - INTERVAL '1 hour'
    AND bucket.bucket_ts >= bounds.window_end - INTERVAL '1 hour 15 minutes'
  ORDER BY bucket.bucket_ts DESC LIMIT 1
) baseline_1h ON true
LEFT JOIN LATERAL (
  SELECT close_price_usd AS price_usd FROM robinhood_market_buckets_1m bucket, bounds
  WHERE bucket.chain = 'robinhood' AND bucket.protocol = page.protocol
    AND bucket.market_key = page.market_key
    AND bucket.bucket_ts <= bounds.window_end - INTERVAL '6 hours'
    AND bucket.bucket_ts >= bounds.window_end - INTERVAL '6 hours 15 minutes'
  ORDER BY bucket.bucket_ts DESC LIMIT 1
) baseline_6h ON true
LEFT JOIN LATERAL (
  SELECT close_price_usd AS price_usd FROM robinhood_market_buckets_1m bucket, bounds
  WHERE bucket.chain = 'robinhood' AND bucket.protocol = page.protocol
    AND bucket.market_key = page.market_key
    AND bucket.bucket_ts <= bounds.window_end - INTERVAL '24 hours'
    AND bucket.bucket_ts >= bounds.window_end - INTERVAL '24 hours 15 minutes'
  ORDER BY bucket.bucket_ts DESC LIMIT 1
) baseline_24h ON true
ORDER BY page.token_volume_24h_usd DESC, page.token_last_observed_at DESC,
  page.token_address ASC`;

function parseCursor(value) {
  if (value == null || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!/^\d+(?:\.\d+)?$/.test(String(parsed.volumeUsd))) throw new Error('volume');
    const asOf = new Date(parsed.asOf);
    const lastObservedAt = new Date(parsed.lastObservedAt);
    if (!Number.isFinite(asOf.getTime()) || !Number.isFinite(lastObservedAt.getTime())) {
      throw new Error('timestamp');
    }
    return {
      volumeUsd: String(parsed.volumeUsd), asOf,
      lastObservedAt, tokenAddress: normalizeTokenAddress(CHAIN, parsed.tokenAddress),
    };
  } catch (_) {
    throw new Error('Invalid Robinhood dashboard cursor');
  }
}

function normalizeQuery(options = {}) {
  const cursor = parseCursor(options.cursor);
  const requestedDate = options.asOf == null ? null : new Date(options.asOf);
  if (requestedDate && !Number.isFinite(requestedDate.getTime())) {
    throw new Error('Robinhood dashboard asOf must be valid');
  }
  const requestedAsOf = requestedDate;
  if (cursor && requestedAsOf && cursor.asOf.getTime() !== requestedAsOf.getTime()) {
    throw new Error('Robinhood dashboard cursor asOf does not match request');
  }
  const asOf = cursor?.asOf || requestedAsOf || new Date();
  return {
    asOf,
    cursor,
    limit: normalizeLimit(options.limit),
    statementTimeoutMs: normalizeStatementTimeout(options.statementTimeoutMs),
  };
}

function normalizeLimit(value) {
  const requested = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error('Robinhood dashboard limit must be a positive safe integer');
  }
  return Math.min(requested, MAX_LIMIT);
}

function normalizeStatementTimeout(value) {
  const timeoutMs = Number(value ?? 10_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    throw new Error('Robinhood statementTimeoutMs must be between 1000 and 60000');
  }
  return timeoutMs;
}

function normalizeActiveQuery(options = {}) {
  const asOf = options.asOf == null ? new Date() : new Date(options.asOf);
  if (!Number.isFinite(asOf.getTime())) {
    throw new Error('Robinhood active dashboard asOf must be valid');
  }
  const parsedMinFdv = Number(options.minFdv ?? 30_000);
  return {
    asOf,
    minFdv: Number.isFinite(parsedMinFdv) ? Math.max(0, parsedMinFdv) : 30_000,
    statementTimeoutMs: normalizeStatementTimeout(options.statementTimeoutMs ?? 15_000),
  };
}

function countValue(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function iso(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function priceChange(current, baseline) {
  if (baseline == null || Number(baseline) <= 0) return null;
  return String(((Number(current) / Number(baseline)) - 1) * 100);
}

function normalizeRow(row, asOf) {
  const lastObservedAt = iso(row.token_last_observed_at, 'last observed timestamp');
  const quoteAgeMs = Math.max(0, asOf.getTime() - new Date(lastObservedAt).getTime());
  const liquidityCoverage = Number(row.incomplete_liquidity_markets) === 0
    ? 'complete' : 'partial';
  return Object.freeze({
    chain: CHAIN,
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    protocol: String(row.protocol), marketKey: String(row.market_key),
    quoteAddress: normalizeTokenAddress(CHAIN, row.quote_address),
    discoveredAt: iso(row.token_discovered_at, 'discovered timestamp'),
    firstObservedAt: iso(row.token_first_observed_at, 'first observed timestamp'),
    lastObservedAt, quoteAgeMs, freshness: quoteAgeMs <= FRESH_MS ? 'fresh' : 'stale',
    lastPriceUsd: String(row.last_price_usd), lastFdvUsd: String(row.last_fdv_usd),
    volume5mUsd: String(row.volume_5m_usd), volume1hUsd: String(row.volume_1h_usd),
    volume6hUsd: String(row.volume_6h_usd), volume24hUsd: String(row.exact_volume_24h_usd),
    swaps24h: countValue(row.exact_swaps_24h, '24h swaps'),
    transactions24h: countValue(row.exact_transactions_24h, '24h transactions'),
    priceChange1hPct: priceChange(row.last_price_usd, row.price_1h_usd),
    priceChange6hPct: priceChange(row.last_price_usd, row.price_6h_usd),
    priceChange24hPct: priceChange(row.last_price_usd, row.price_24h_usd),
    liquidityUsd: liquidityCoverage === 'complete' && row.token_liquidity_usd != null
      ? String(row.token_liquidity_usd) : null,
    primaryMarketLiquidityUsd: row.last_liquidity_usd == null
      ? null : String(row.last_liquidity_usd),
    liquidityCoverage,
    liquidityStatus: liquidityCoverage === 'complete'
      ? String(row.last_liquidity_status || 'not_observed') : 'partial_protocol_coverage',
    liquidityConfidence: liquidityCoverage === 'complete'
      ? (row.last_liquidity_confidence == null ? null : String(row.last_liquidity_confidence))
      : 'none',
    liquidityWarning: row.last_liquidity_warning == null
      ? null : String(row.last_liquidity_warning),
    marketCount: countValue(row.token_market_count, 'market count'),
    protocolBreakdown: Object.freeze(row.protocol_breakdown || {}),
    marketBreakdown: Object.freeze(Array.isArray(row.market_breakdown) ? row.market_breakdown : []),
  });
}

function encodeCursor(row, asOf) {
  return Buffer.from(JSON.stringify({
    asOf: asOf.toISOString(),
    volumeUsd: String(row.token_volume_24h_usd ?? row.volume24hUsd),
    lastObservedAt: iso(
      row.token_last_observed_at ?? row.lastObservedAt, 'cursor last observed timestamp',
    ),
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address ?? row.tokenAddress),
  })).toString('base64url');
}

function createRobinhoodDashboardReadRepository(options = {}) {
  const database = options.database || db;
  async function listActiveCatalogRows(input = {}) {
    const query = normalizeActiveQuery(input);
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, values) => database.queryWithStatementTimeout(
        sql, values, query.statementTimeoutMs,
      )
      : (sql, values) => database.query(sql, values);
    const result = await execute(ACTIVE_CATALOG_ROWS_SQL, [query.asOf, query.minFdv]);
    return result.rows;
  }

  async function listTokenPage(input = {}) {
    const query = normalizeQuery(input);
    const params = [query.asOf, query.limit + 1, query.cursor?.volumeUsd || null,
      query.cursor?.lastObservedAt || null, query.cursor?.tokenAddress || null];
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, values) => database.queryWithStatementTimeout(
        sql, values, query.statementTimeoutMs,
      )
      : (sql, values) => database.query(sql, values);
    const result = await execute(DASHBOARD_PAGE_SQL, params);
    const selectedRows = result.rows.slice(0, query.limit);
    const rows = selectedRows.map((row) => normalizeRow(row, query.asOf));
    const hasMore = result.rows.length > query.limit;
    return Object.freeze({
      chain: CHAIN, asOf: query.asOf.toISOString(), rows: Object.freeze(rows), hasMore,
      nextCursor: hasMore && rows.length
        ? encodeCursor(selectedRows[selectedRows.length - 1], query.asOf) : null,
      exclusionPolicy: Object.freeze({
        staleAfterMs: FRESH_MS,
        reasons: Object.freeze([
          'admin_blocked', 'inactive_market', 'no_activity_in_freshness_window',
        ]),
      }),
    });
  }
  return Object.freeze({ listActiveCatalogRows, listTokenPage });
}

module.exports = {
  createRobinhoodDashboardReadRepository,
  __private: {
    ACTIVE_CATALOG_ROWS_SQL,
    DASHBOARD_PAGE_SQL,
    encodeCursor,
    normalizeActiveQuery,
    normalizeQuery,
    normalizeRow,
    parseCursor,
  },
};
