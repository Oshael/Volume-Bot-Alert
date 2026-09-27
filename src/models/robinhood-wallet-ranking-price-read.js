const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MAX_TOKENS = 100;
const TIMEOUT_MS = 5000;
const WINDOW_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  ALL: null,
});

function priceSql(window) {
  const baselineTable = window === '30d'
    ? 'robinhood_market_buckets_1h' : 'robinhood_market_buckets_1m';
  const baselineTolerance = window === '30d' ? '2 hours' : '15 minutes';
  const baselineTruncation = window === '30d' ? 'hour' : 'minute';
  const baselineJoin = window === 'ALL' ? '' : `
LEFT JOIN LATERAL (
  SELECT bucket.close_price_usd, bucket.last_observed_at
    FROM ${baselineTable} bucket
   WHERE bucket.chain = '${CHAIN}' AND bucket.token_address = requested.token_address
     AND bucket.protocol = valuation.valuation_protocol
     AND bucket.market_key = valuation.valuation_market_key
     AND bucket.bucket_ts >= date_trunc('${baselineTruncation}',
       $3::timestamptz - INTERVAL '${baselineTolerance}')
     AND bucket.bucket_ts <= $3::timestamptz
     AND bucket.last_observed_at BETWEEN
       $3::timestamptz - INTERVAL '${baselineTolerance}' AND $3::timestamptz
   ORDER BY bucket.bucket_ts DESC, bucket.last_observed_at DESC,
     bucket.last_block_number DESC, bucket.last_log_index DESC
   LIMIT 1
) baseline ON TRUE`;
  return `WITH requested AS MATERIALIZED (
  SELECT DISTINCT UNNEST($1::varchar[]) AS token_address
)
SELECT requested.token_address, valuation.valuation_protocol AS protocol,
  valuation.valuation_market_key AS market_key,
  current_price.close_price_usd AS current_price_usd,
  current_price.last_observed_at AS current_observed_at,
  ${window === 'ALL' ? 'NULL::numeric' : 'baseline.close_price_usd'} AS window_start_price_usd,
  ${window === 'ALL' ? 'NULL::timestamptz' : 'baseline.last_observed_at'} AS window_start_observed_at
FROM requested
LEFT JOIN LATERAL (
  SELECT bucket.valuation_protocol, bucket.valuation_market_key
    FROM robinhood_market_buckets_agg bucket
   WHERE bucket.chain = '${CHAIN}' AND bucket.token_address = requested.token_address
     AND bucket.granularity_minutes = 5
     AND bucket.source_granularity_minutes = 1
     AND bucket.bucket_ts >= $2::timestamptz - INTERVAL '15 minutes'
     AND bucket.bucket_ts <= $2::timestamptz
     AND bucket.last_observed_at <= $2::timestamptz
   ORDER BY bucket.bucket_ts DESC LIMIT 1
) valuation ON TRUE
LEFT JOIN LATERAL (
  SELECT bucket.close_price_usd, bucket.last_observed_at
    FROM robinhood_market_buckets_1m bucket
   WHERE bucket.chain = '${CHAIN}' AND bucket.token_address = requested.token_address
     AND bucket.protocol = valuation.valuation_protocol
     AND bucket.market_key = valuation.valuation_market_key
     AND bucket.bucket_ts >= date_trunc('minute',
       $2::timestamptz - INTERVAL '15 minutes')
     AND bucket.bucket_ts <= $2::timestamptz
     AND bucket.last_observed_at BETWEEN
       $2::timestamptz - INTERVAL '15 minutes' AND $2::timestamptz
   ORDER BY bucket.bucket_ts DESC, bucket.last_observed_at DESC,
     bucket.last_block_number DESC, bucket.last_log_index DESC
   LIMIT 1
) current_price ON TRUE${baselineJoin}
ORDER BY requested.token_address`;
}

function normalizeAsOf(value) {
  const date = value == null ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('asOf is invalid');
  return date;
}

function normalizeTokens(values) {
  if (!Array.isArray(values) || values.length > MAX_TOKENS) {
    throw new Error(`tokenAddresses must contain at most ${MAX_TOKENS} tokens`);
  }
  return [...new Set(values.map((value) => normalizeTokenAddress(CHAIN, value)))];
}

function mapRow(row, window, asOf, windowStart) {
  const currentPriceUsd = row.current_price_usd == null ? null : String(row.current_price_usd);
  const windowStartPriceUsd = row.window_start_price_usd == null
    ? null : String(row.window_start_price_usd);
  const reasons = [];
  if (currentPriceUsd == null) reasons.push('current_price_unavailable');
  if (window !== 'ALL' && windowStartPriceUsd == null) {
    reasons.push('window_start_price_unavailable');
  }
  return {
    tokenAddress: row.token_address,
    window,
    asOf: asOf.toISOString(),
    windowStart: windowStart?.toISOString() ?? null,
    currentPriceUsd,
    currentObservedAt: row.current_observed_at?.toISOString() ?? null,
    windowStartPriceUsd,
    windowStartObservedAt: row.window_start_observed_at?.toISOString() ?? null,
    protocol: row.protocol,
    marketKey: row.market_key,
    coverage: reasons.length ? 'partial' : 'complete',
    reasons,
  };
}

function createRobinhoodWalletRankingPriceReadRepository(options = {}) {
  const database = options.database || db;
  return {
    async getPrices({ tokenAddresses, window, asOf } = {}) {
      if (!Object.hasOwn(WINDOW_MS, window)) throw new Error('window is invalid');
      const tokens = normalizeTokens(tokenAddresses);
      if (!tokens.length) return [];
      const end = normalizeAsOf(asOf);
      const start = WINDOW_MS[window] == null
        ? null : new Date(end.getTime() - WINDOW_MS[window]);
      const params = start == null ? [tokens, end] : [tokens, end, start];
      const sql = priceSql(window);
      const result = await database.queryWithStatementTimeout(sql, params, TIMEOUT_MS);
      return result.rows.map((row) => mapRow(row, window, end, start));
    },
  };
}

module.exports = { createRobinhoodWalletRankingPriceReadRepository };
