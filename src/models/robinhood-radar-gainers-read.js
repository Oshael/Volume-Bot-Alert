const db = require('./db');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const { normalizeAsOf } = require('../services/workspace-window-metrics');
const { MAX_CATALOG_FDV_USD } = require('../services/robinhood-catalog-fdv-policy');

const TIMEOUT_MS = 5000;
const MAX_LIMIT = 20;

// Rank the eligible universe in SQL; only the bounded winners leave the database.
// Minute buckets contain accepted observations. Never compare different markets
// or substitute the catalog price for a missing/stale canonical price.
const SQL = `WITH candidates AS MATERIALIZED (
  SELECT tc.address, tc.symbol, tc.name, tc.last_image_url,
    tc.last_token_created_at_ms AS created_at_ms
  FROM token_catalog tc
  WHERE tc.chain = 'robinhood'
    AND tc.last_token_created_at_ms > 0
    AND tc.last_token_created_at_ms BETWEEN
      (EXTRACT(EPOCH FROM $1::timestamptz - INTERVAL '24 hours') * 1000)::bigint
      AND (EXTRACT(EPOCH FROM $1::timestamptz) * 1000)::bigint
    AND tc.address <> ALL($2::varchar[])
    AND NOT EXISTS (SELECT 1 FROM admin_blocked_tokens blocked
      WHERE blocked.chain = 'robinhood' AND blocked.address = tc.address)
), points AS MATERIALIZED (
  SELECT candidate.*, first_price.open_price_usd AS first_price_usd,
    first_price.first_observed_at, first_price.protocol AS first_protocol,
    first_price.market_key AS first_market_key,
    current_price.close_price_usd AS current_price_usd,
    current_price.last_observed_at, current_price.close_fdv_usd AS fdv_usd,
    valuation.valuation_protocol AS protocol, valuation.valuation_market_key AS market_key
  FROM candidates candidate
  LEFT JOIN LATERAL (
    SELECT bucket.open_price_usd, bucket.first_observed_at, bucket.protocol, bucket.market_key
    FROM robinhood_market_buckets_1m bucket
    WHERE bucket.chain = 'robinhood' AND bucket.token_address = candidate.address
      AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
      AND bucket.bucket_ts >= date_trunc('minute', $1::timestamptz - INTERVAL '24 hours')
      AND bucket.bucket_ts <= $1::timestamptz
      AND bucket.first_observed_at >= TO_TIMESTAMP(candidate.created_at_ms::numeric / 1000)
      AND bucket.last_observed_at <= $1::timestamptz
      AND bucket.open_price_usd > 0
      AND bucket.open_price_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
    ORDER BY bucket.bucket_ts, bucket.first_block_number, bucket.first_log_index,
      bucket.protocol, bucket.market_key
    LIMIT 1
  ) first_price ON TRUE
  LEFT JOIN LATERAL (
    SELECT bucket.valuation_protocol, bucket.valuation_market_key
    FROM robinhood_market_buckets_agg bucket
    WHERE bucket.chain = 'robinhood' AND bucket.token_address = candidate.address
      AND bucket.granularity_minutes = 5 AND bucket.source_granularity_minutes = 1
      AND bucket.bucket_ts >= date_bin(INTERVAL '5 minutes',
        $1::timestamptz - INTERVAL '15 minutes', '1970-01-01'::timestamptz)
      AND bucket.bucket_ts <= $1::timestamptz
      AND bucket.last_observed_at BETWEEN $1::timestamptz - INTERVAL '15 minutes' AND $1::timestamptz
    ORDER BY bucket.bucket_ts DESC LIMIT 1
  ) valuation ON TRUE
  LEFT JOIN LATERAL (
    SELECT bucket.close_price_usd, bucket.last_observed_at, bucket.close_fdv_usd
    FROM robinhood_market_buckets_1m bucket
    WHERE bucket.chain = 'robinhood' AND bucket.token_address = candidate.address
      AND bucket.protocol = valuation.valuation_protocol
      AND bucket.market_key = valuation.valuation_market_key
      AND bucket.bucket_ts >= date_trunc('minute', $1::timestamptz - INTERVAL '15 minutes')
      AND bucket.bucket_ts <= $1::timestamptz
      AND bucket.last_observed_at BETWEEN $1::timestamptz - INTERVAL '15 minutes' AND $1::timestamptz
    ORDER BY bucket.bucket_ts DESC, bucket.last_block_number DESC, bucket.last_log_index DESC
    LIMIT 1
  ) current_price ON TRUE
), scored AS MATERIALIZED (
  SELECT points.*, CASE WHEN first_price_usd > 0 AND current_price_usd > 0
    AND current_price_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
    AND first_protocol = protocol AND first_market_key = market_key
    AND first_observed_at <= last_observed_at
    THEN (current_price_usd / first_price_usd - 1) * 100 END AS change_pct
  FROM points
  WHERE fdv_usd IS NULL OR fdv_usd < ${MAX_CATALOG_FDV_USD}
), winners AS (
  SELECT * FROM scored WHERE change_pct > 0
  ORDER BY change_pct DESC, address COLLATE "C" LIMIT $3::int
)
SELECT (SELECT COUNT(*)::int FROM scored) AS candidate_count,
  (SELECT COUNT(*)::int FROM scored WHERE change_pct IS NULL) AS unpriced_count,
  (SELECT COUNT(*)::int FROM scored WHERE change_pct > 0) AS total,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'address', address, 'symbol', symbol, 'name', name, 'imageUrl', last_image_url,
    'createdAt', created_at_ms::text, 'priceChangePct', change_pct::text,
    'firstPriceUsd', first_price_usd::text, 'firstObservedAt', first_observed_at,
    'currentPriceUsd', current_price_usd::text, 'currentObservedAt', last_observed_at,
    'fdvUsd', fdv_usd::text, 'protocol', protocol, 'marketKey', market_key
  ) ORDER BY change_pct DESC, address COLLATE "C") FROM winners), '[]'::jsonb) AS items`;

function normalizeInput(input) {
  const asOf = normalizeAsOf(input.asOf);
  const limit = input.limit ?? 15;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`gainers limit must be between 1 and ${MAX_LIMIT}`);
  }
  const excluded = input.excludedAddresses ?? [];
  if (!Array.isArray(excluded) || excluded.length > 5000) {
    throw new Error('gainers exclusions must contain at most 5000 addresses');
  }
  return { asOf, limit,
    excluded: [...new Set(excluded.map((address) => normalizeTokenAddress('robinhood', address)))] };
}

function mapItem(item) {
  return {
    identity: createTokenIdentity('robinhood', item.address),
    symbol: item.symbol, name: item.name, imageUrl: item.imageUrl,
    createdAt: Number(item.createdAt), priceChangePct: item.priceChangePct,
    priceUsd: item.currentPriceUsd, priceObservedAt: new Date(item.currentObservedAt).toISOString(),
    fdvUsd: item.fdvUsd,
    priceBasis: { type: 'first-observed-price', coverage: 'available-history',
      priceUsd: item.firstPriceUsd, observedAt: new Date(item.firstObservedAt).toISOString(),
      protocol: item.protocol, marketKey: item.marketKey },
  };
}

function createRobinhoodRadarGainersReadRepository(options = {}) {
  const database = options.database || db;
  return {
    async getGainers(input = {}) {
      const { asOf, limit, excluded } = normalizeInput(input);
      const result = await database.queryWithStatementTimeout(SQL, [asOf, excluded, limit], TIMEOUT_MS);
      const row = result.rows[0];
      return { chain: 'robinhood', asOf: asOf.toISOString(), limit,
        candidateCount: row.candidate_count, unpricedCount: row.unpriced_count,
        total: row.total, hasMore: row.total > row.items.length,
        items: row.items.map(mapItem) };
    },
  };
}

module.exports = { createRobinhoodRadarGainersReadRepository };
