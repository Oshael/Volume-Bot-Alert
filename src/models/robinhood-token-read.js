const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MINUTE_MS = 60 * 1000;
const MAX_WINDOW_MS = 14 * 24 * 60 * MINUTE_MS;
const MAX_LIMIT = 5000;
const MAX_TARGETED_ADDRESSES = 100;
const TOKEN_FILTER_MARKER = '/* robinhood_token_filter */';

const AGGREGATE_SIGNAL_SQL_TEMPLATE = `WITH bounds AS (
  SELECT CASE WHEN $4::boolean
    THEN date_trunc('minute', COALESCE($3::timestamptz, NOW()))
    ELSE COALESCE($3::timestamptz, NOW())
  END AS window_end
),
market_activity AS MATERIALIZED (
  SELECT
    bucket.protocol,
    bucket.market_key,
    bucket.token_address,
    bucket.quote_address,
    MIN(registry.discovered_at) AS discovered_at,
    MIN(bucket.first_observed_at) AS first_observed_at,
    MAX(bucket.last_observed_at) AS last_observed_at,
    SUM(bucket.volume_usd) AS volume_usd,
    SUM(bucket.swaps)::bigint AS swaps,
    SUM(bucket.buys)::bigint AS buys,
    SUM(bucket.sells)::bigint AS sells,
    SUM(bucket.transactions)::bigint AS transactions,
    (array_agg(bucket.close_price_usd ORDER BY
      bucket.last_block_number DESC, bucket.last_log_index DESC))[1] AS last_price_usd,
    (array_agg(bucket.close_fdv_usd ORDER BY
      bucket.last_block_number DESC, bucket.last_log_index DESC))[1] AS last_fdv_usd,
    (array_agg(bucket.close_liquidity_usd ORDER BY
      bucket.last_block_number DESC, bucket.last_log_index DESC))[1] AS last_liquidity_usd,
    (array_agg(bucket.close_liquidity_status ORDER BY
      bucket.last_block_number DESC, bucket.last_log_index DESC))[1] AS last_liquidity_status,
    (array_agg(bucket.close_liquidity_confidence ORDER BY
      bucket.last_block_number DESC, bucket.last_log_index DESC))[1]
      AS last_liquidity_confidence,
    (array_agg(bucket.close_liquidity_warning ORDER BY
      bucket.last_block_number DESC, bucket.last_log_index DESC))[1]
      AS last_liquidity_warning,
    bounds.window_end - ($1::bigint * INTERVAL '1 millisecond') AS window_start,
    bounds.window_end
  FROM robinhood_market_buckets_1m bucket
  CROSS JOIN bounds
  INNER JOIN robinhood_pool_registry registry
    ON registry.chain = bucket.chain
   AND registry.protocol = bucket.protocol
   AND registry.market_key = bucket.market_key
   AND registry.token_address = bucket.token_address
   AND registry.quote_address = bucket.quote_address
   AND registry.active = true
  WHERE bucket.chain = 'robinhood'
    ${TOKEN_FILTER_MARKER}
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= bounds.window_end
      - ($1::bigint * INTERVAL '1 millisecond')
    AND bucket.bucket_ts < bounds.window_end
  GROUP BY bucket.protocol, bucket.market_key, bucket.token_address,
    bucket.quote_address, bounds.window_end
),
ranked AS (
  SELECT
    activity.*,
    SUM(activity.volume_usd) OVER token AS token_volume_usd,
    SUM(activity.swaps) OVER token AS token_swaps,
    SUM(activity.buys) OVER token AS token_buys,
    SUM(activity.sells) OVER token AS token_sells,
    SUM(activity.transactions) OVER token AS token_transactions,
    SUM(activity.last_liquidity_usd) OVER token AS token_liquidity_usd,
    MIN(activity.discovered_at) OVER token AS token_discovered_at,
    MIN(activity.first_observed_at) OVER token AS token_first_observed_at,
    MAX(activity.last_observed_at) OVER token AS token_last_observed_at,
    COUNT(*) OVER token AS token_market_count,
    COUNT(*) FILTER (WHERE activity.protocol <> 'uniswap-v2'
      OR activity.last_liquidity_usd IS NULL) OVER token AS incomplete_liquidity_markets,
    ROW_NUMBER() OVER (
      PARTITION BY activity.token_address
      ORDER BY activity.volume_usd DESC, activity.last_observed_at DESC,
        activity.protocol ASC, activity.market_key ASC
    ) AS primary_rank
  FROM market_activity activity
  WINDOW token AS (PARTITION BY activity.token_address)
)
SELECT
  ranked.*,
  COALESCE((
    SELECT jsonb_object_agg(protocol_row.protocol, jsonb_build_object(
      'volumeUsd', protocol_row.volume_usd::text,
      'swaps', protocol_row.swaps::text,
      'buys', protocol_row.buys::text,
      'sells', protocol_row.sells::text,
      'transactions', protocol_row.transactions::text,
      'markets', protocol_row.markets::text
    ) ORDER BY protocol_row.protocol)
    FROM (
      SELECT protocol, SUM(volume_usd) AS volume_usd, SUM(swaps) AS swaps,
        SUM(buys) AS buys, SUM(sells) AS sells, SUM(transactions) AS transactions,
        COUNT(*) AS markets
      FROM market_activity protocol_market
      WHERE protocol_market.token_address = ranked.token_address
      GROUP BY protocol
    ) protocol_row
  ), '{}'::jsonb) AS protocol_breakdown,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'protocol', market.protocol,
      'marketKey', market.market_key,
      'quoteAddress', market.quote_address,
      'volumeUsd', market.volume_usd::text,
      'swaps', market.swaps::text,
      'transactions', market.transactions::text,
      'lastObservedAt', market.last_observed_at
    ) ORDER BY market.volume_usd DESC, market.last_observed_at DESC,
      market.protocol ASC, market.market_key ASC)
    FROM market_activity market
    WHERE market.token_address = ranked.token_address
  ), '[]'::jsonb) AS market_breakdown,
  EXISTS (
    SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'robinhood'
      AND blocked.address = ranked.token_address
  ) AS admin_blocked
FROM ranked
WHERE ranked.primary_rank = 1
ORDER BY ranked.token_volume_usd DESC, ranked.token_last_observed_at DESC,
  ranked.token_address ASC
LIMIT $2::int`;

function buildAggregateSignalSql(targeted = false) {
  return AGGREGATE_SIGNAL_SQL_TEMPLATE.replace(
    TOKEN_FILTER_MARKER,
    targeted ? 'AND bucket.token_address = ANY($5::varchar[])' : '',
  );
}

const AGGREGATE_SIGNAL_SQL = buildAggregateSignalSql();
const TARGETED_SIGNAL_SQL = buildAggregateSignalSql(true);

function normalizeQuery(options = {}) {
  const windowMs = Number(options.windowMs);
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0
    || windowMs % MINUTE_MS !== 0 || windowMs > MAX_WINDOW_MS) {
    throw new Error('Robinhood windowMs must be a whole minute between 1 minute and 14 days');
  }
  const requestedLimit = options.limit == null ? 500 : Number(options.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('Robinhood candidate limit must be a positive safe integer');
  }
  const asOf = options.asOf == null ? null : new Date(options.asOf);
  if (asOf && !Number.isFinite(asOf.getTime())) throw new Error('Robinhood asOf must be valid');
  const statementTimeoutMs = Number(options.statementTimeoutMs ?? 10_000);
  if (!Number.isSafeInteger(statementTimeoutMs)
    || statementTimeoutMs < 1000 || statementTimeoutMs > 60_000) {
    throw new Error('Robinhood statementTimeoutMs must be between 1000 and 60000');
  }
  return {
    windowMs,
    limit: Math.min(requestedLimit, MAX_LIMIT),
    asOf,
    alignToMinute: options.alignToMinute !== false,
    statementTimeoutMs,
  };
}

function countValue(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside safe integer range`);
  }
  return parsed;
}

function timestampIso(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function normalizeBreakdown(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeTargetAddresses(values) {
  if (!Array.isArray(values)) throw new TypeError('Robinhood target addresses must be an array');
  const addresses = [...new Set(values.map((value) => normalizeTokenAddress(CHAIN, value)))];
  if (addresses.length > MAX_TARGETED_ADDRESSES) {
    throw new RangeError(`Robinhood targeted read accepts at most ${MAX_TARGETED_ADDRESSES} addresses`);
  }
  return addresses;
}

function normalizeCandidate(row, windowMs) {
  const liquidityCoverage = Number(row.incomplete_liquidity_markets) === 0
    ? 'complete'
    : 'partial';
  return Object.freeze({
    chain: CHAIN,
    protocol: String(row.protocol),
    marketKey: String(row.market_key),
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    quoteAddress: normalizeTokenAddress(CHAIN, row.quote_address),
    discoveredAt: timestampIso(row.token_discovered_at, 'token discovered_at'),
    firstObservedAt: timestampIso(row.token_first_observed_at, 'token first_observed_at'),
    lastObservedAt: timestampIso(row.token_last_observed_at, 'token last_observed_at'),
    windowMs,
    windowStart: timestampIso(row.window_start, 'candidate window_start'),
    windowEnd: timestampIso(row.window_end, 'candidate window_end'),
    volumeUsd: String(row.token_volume_usd),
    swaps: countValue(row.token_swaps, 'candidate swaps'),
    buys: countValue(row.token_buys, 'candidate buys'),
    sells: countValue(row.token_sells, 'candidate sells'),
    transactions: countValue(row.token_transactions, 'candidate transactions'),
    lastPriceUsd: String(row.last_price_usd),
    lastFdvUsd: String(row.last_fdv_usd),
    liquidityUsd: liquidityCoverage === 'complete' && row.token_liquidity_usd != null
      ? String(row.token_liquidity_usd)
      : null,
    primaryMarketLiquidityUsd: row.last_liquidity_usd == null
      ? null
      : String(row.last_liquidity_usd),
    liquidityCoverage,
    liquidityStatus: liquidityCoverage === 'complete'
      ? String(row.last_liquidity_status || 'not_observed')
      : 'partial_protocol_coverage',
    liquidityConfidence: liquidityCoverage === 'complete'
      ? (row.last_liquidity_confidence == null ? null : String(row.last_liquidity_confidence))
      : 'none',
    liquidityWarning: row.last_liquidity_warning == null
      ? null
      : String(row.last_liquidity_warning),
    marketCount: countValue(row.token_market_count, 'candidate market count'),
    protocolBreakdown: Object.freeze(normalizeBreakdown(row.protocol_breakdown)),
    marketBreakdown: Object.freeze(Array.isArray(row.market_breakdown) ? row.market_breakdown : []),
    adminBlocked: row.admin_blocked === true,
  });
}

function createRobinhoodTokenReadRepository(options = {}) {
  const database = options.database || db;

  async function readCandidates(input, targetAddresses = null) {
    const query = normalizeQuery(input);
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, params) => database.queryWithStatementTimeout(sql, params, query.statementTimeoutMs)
      : (sql, params) => database.query(sql, params);
    const targeted = targetAddresses !== null;
    const result = await execute(
      targeted ? TARGETED_SIGNAL_SQL : AGGREGATE_SIGNAL_SQL,
      [query.windowMs, query.limit, query.asOf, query.alignToMinute,
        ...(targeted ? [targetAddresses] : [])],
    );
    const candidates = result.rows.map((row) => normalizeCandidate(row, query.windowMs));
    if (targeted) {
      const requested = new Set(targetAddresses);
      if (candidates.some((candidate) => !requested.has(candidate.tokenAddress))) {
        throw new Error('Robinhood targeted read returned an unrequested token');
      }
    }
    return candidates;
  }

  async function listSignalDryRunCandidates(input = {}) {
    return readCandidates(input);
  }

  async function listActiveTokenCandidates(input = {}) {
    return listSignalDryRunCandidates({ ...input, alignToMinute: false });
  }

  async function listActiveTokenCandidatesByAddresses(input = {}) {
    const addresses = normalizeTargetAddresses(input.addresses);
    if (!addresses.length) return [];
    return readCandidates({
      ...input,
      limit: addresses.length,
      alignToMinute: false,
    }, addresses);
  }

  return Object.freeze({
    listActiveTokenCandidates,
    listActiveTokenCandidatesByAddresses,
    listSignalDryRunCandidates,
  });
}

module.exports = {
  createRobinhoodTokenReadRepository,
  __private: {
    AGGREGATE_SIGNAL_SQL,
    TARGETED_SIGNAL_SQL,
    buildAggregateSignalSql,
    normalizeCandidate,
    normalizeQuery,
    normalizeTargetAddresses,
  },
};
