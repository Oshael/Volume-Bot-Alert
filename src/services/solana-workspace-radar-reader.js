const db = require('../models/db');
const {
  createSolanaWorkspaceWindowReadRepository,
} = require('../models/solana-workspace-window-read');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const { evaluateWorkspaceVisibility } = require('./workspace-visibility-policy');
const {
  compareRadarRows,
  isRadarAgeInQuery,
  normalizeRadarQuery,
  resolveRadarTokenAge,
} = require('./dashboard-radar-query');

const CHAIN = 'solana';
const METRIC_BATCH_SIZE = 100;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const AGE_SQL = `COALESCE(NULLIF(tc.last_token_created_at_ms, 0),
  EXTRACT(EPOCH FROM tc.first_seen_at) * 1000)`;
const VOLUME_COLUMNS = Object.freeze({
  '1h': 'close_vol_1h', '6h': 'close_vol_6h', '24h': 'close_vol_24h',
});

function volumeCoverageStateSql(window) {
  return `CASE jsonb_typeof(volume.window_coverage -> '${window}')
    WHEN 'object' THEN volume.window_coverage -> '${window}' ->> 'state'
    WHEN 'string' THEN volume.window_coverage ->> '${window}' ELSE NULL END`;
}

function volumeCoverageRankSql(window) {
  const column = VOLUME_COLUMNS[window];
  return `CASE WHEN volume.${column} IS NULL OR volume.bucket_ts IS NULL THEN 2
    WHEN volume.bucket_ts < $1::timestamptz - INTERVAL '1 minute'
      OR (${volumeCoverageStateSql(window)}) IS DISTINCT FROM 'complete' THEN 1 ELSE 0 END`;
}

function priceValueSql(window) {
  return `CASE WHEN prices.current_price > 0 AND prices.price_${window} > 0
    AND prices.current_observed_at >= $1::timestamptz - INTERVAL '15 minutes'
    AND prices.price_${window}_observed_at >= $1::timestamptz
      - INTERVAL '${window}' - INTERVAL '15 minutes'
    THEN ((prices.current_price / prices.price_${window}) - 1) * 100 ELSE NULL END`;
}

function priceCoverageRankSql(window) {
  return `CASE WHEN prices.current_observed_at IS NULL
      OR prices.price_${window}_observed_at IS NULL THEN 2
    WHEN prices.current_observed_at < $1::timestamptz - INTERVAL '15 minutes'
      OR prices.price_${window}_observed_at < $1::timestamptz
        - INTERVAL '${window}' - INTERVAL '15 minutes' THEN 1 ELSE 0 END`;
}

function buildOrderSql(sorts) {
  const clauses = [];
  for (const sort of sorts) {
    if (sort.mode === 'vol') {
      clauses.push(`volume.${VOLUME_COLUMNS[sort.window]} DESC NULLS LAST`);
      clauses.push(`${volumeCoverageRankSql(sort.window)} ASC`);
    } else if (sort.mode === 'pchange') {
      clauses.push(`${priceCoverageRankSql(sort.window)} ASC`);
      clauses.push(`(${priceValueSql(sort.window)}) DESC NULLS LAST`);
    } else if (sort.mode === 'mcap') {
      clauses.push(`tc.last_mcap ${sort.window === 'lowest' ? 'ASC' : 'DESC'} NULLS LAST`);
    } else {
      clauses.push(`${AGE_SQL} ${sort.window === 'oldest' ? 'ASC' : 'DESC'} NULLS LAST`);
    }
  }
  clauses.push('tc.address COLLATE "C" ASC');
  return clauses.join(',\n  ');
}

function buildCatalogSql(sorts) {
  return `SELECT tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_seen_at, tc.last_evaluated_at, tc.last_token_created_at_ms,
  tc.last_mcap, tc.last_price, tc.last_liquidity_usd, tc.last_pair_address,
  tc.last_pair_url, tc.last_dex_id, tc.last_image_url, tc.last_twitter_url,
  tc.last_community_url, tc.monitor_priority, COUNT(*) OVER() AS total_count
FROM token_catalog tc
LEFT JOIN LATERAL (
  SELECT bucket_ts, close_vol_1h, close_vol_6h, close_vol_24h, window_coverage
  FROM token_market_volume_buckets_1m bucket
  WHERE bucket.chain = 'solana' AND bucket.token_address = tc.address
    AND bucket.bucket_ts < $1::timestamptz
  ORDER BY bucket.bucket_ts DESC LIMIT 1
) volume ON TRUE
LEFT JOIN LATERAL (
  SELECT
    (array_agg(bucket.close_price ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts >= $1::timestamptz - INTERVAL '15 minutes'))[1]
      AS current_price,
    (array_agg(bucket.bucket_ts ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts >= $1::timestamptz - INTERVAL '15 minutes'))[1]
      AS current_observed_at,
    ${['1h', '6h', '24h'].map((window) => `(array_agg(bucket.close_price ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= $1::timestamptz - INTERVAL '${window}'
        AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '${window}'
          - INTERVAL '15 minutes'))[1] AS price_${window},
    (array_agg(bucket.bucket_ts ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= $1::timestamptz - INTERVAL '${window}'
        AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '${window}'
          - INTERVAL '15 minutes'))[1] AS price_${window}_observed_at`).join(',\n    ')}
  FROM token_market_buckets_1m bucket
  WHERE bucket.chain = 'solana' AND bucket.token_address = tc.address
    AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '24 hours 15 minutes'
    AND bucket.bucket_ts < $1::timestamptz AND bucket.close_price IS NOT NULL
) prices ON TRUE
WHERE tc.chain = 'solana'
  AND ((${AGE_SQL}) IS NOT NULL
    AND (${AGE_SQL}) <= EXTRACT(EPOCH FROM $1::timestamptz) * 1000 - $4::numeric * 60000
    AND ($5::numeric IS NULL OR (${AGE_SQL}) >=
      EXTRACT(EPOCH FROM $1::timestamptz) * 1000 - $5::numeric * 60000))
  AND ((tc.last_mcap IS NULL AND $2::numeric = 0)
    OR (tc.last_mcap >= $2::numeric
      AND ($3::numeric IS NULL OR tc.last_mcap <= $3::numeric)))
  AND ($6::text IS NULL OR LOWER(COALESCE(tc.symbol, '') || ' '
    || COALESCE(tc.name, '') || ' ' || tc.address) LIKE $6::text)
  AND tc.address <> ALL($7::varchar[])
  AND ($8::boolean = FALSE OR tc.address = ANY($9::varchar[]))
  AND NOT EXISTS (SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'solana' AND blocked.address = tc.address)
  AND NOT EXISTS (SELECT 1 FROM token_risk_reviews review
    WHERE review.chain = 'solana' AND review.token_address = tc.address
      AND LOWER(review.source) = 'manual' AND LOWER(review.label) = 'junk_permanent')
ORDER BY ${buildOrderSql(sorts)}
LIMIT $10::int`;
}

const PINNED_SQL = `SELECT tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_seen_at, tc.last_evaluated_at, tc.last_token_created_at_ms,
  tc.last_mcap, tc.last_price, tc.last_liquidity_usd, tc.last_pair_address,
  tc.last_pair_url, tc.last_dex_id, tc.last_image_url, tc.last_twitter_url,
  tc.last_community_url, tc.monitor_priority
FROM token_catalog tc
WHERE tc.chain = 'solana' AND tc.address = ANY($1::varchar[])
  AND NOT EXISTS (SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'solana' AND blocked.address = tc.address)
  AND NOT EXISTS (SELECT 1 FROM token_risk_reviews review
    WHERE review.chain = 'solana' AND review.token_address = tc.address
      AND LOWER(review.source) = 'manual' AND LOWER(review.label) = 'junk_permanent')
ORDER BY array_position($1::varchar[], tc.address)`;

function timeoutMs(value) {
  const parsed = Number(value ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 60_000) {
    throw new Error('Solana radar timeout must be between 1000 and 60000');
  }
  return parsed;
}

function optionalIso(value, label) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function optionalNumber(value, label) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function normalizeRow(row, metrics, query, options = {}) {
  const identity = createTokenIdentity(CHAIN, row.address);
  const tokenAge = resolveRadarTokenAge({
    tokenCreatedAt: row.last_token_created_at_ms, firstSeenAt: row.first_seen_at,
  });
  if (!options.allowAnyAge && !isRadarAgeInQuery(tokenAge, query)) {
    throw new Error(`${identity.key} has invalid radar age`);
  }
  const observedAt = optionalIso(row.last_evaluated_at, 'valuation observedAt');
  const visibility = evaluateWorkspaceVisibility({
    identity,
    state: { lastActivityAt: metrics.lastActivityAt },
    valuation: { type: 'mcap', usd: row.last_mcap, observedAt },
    filters: { minValuationUsd: options.ignoreValuationFilter ? 0 : query.minMcap,
      maxValuationUsd: options.ignoreValuationFilter ? null : query.maxMcap },
  }, { nowMs: new Date(query.asOf).getTime() });
  if (!visibility.visible) throw new Error(`${identity.key} violates its radar filter`);
  const { chain: _chain, address: _address, key: _key, ...windowMetrics } = metrics;
  return Object.freeze({
    identity, tokenAge,
    symbol: row.symbol || null, name: row.name || null, source: row.source || 'unknown',
    firstSeenAt: optionalIso(row.first_seen_at, 'firstSeenAt'),
    lastSeenAt: optionalIso(row.last_seen_at, 'lastSeenAt'),
    lastEvaluatedAt: observedAt,
    valuation: visibility.valuation,
    priceUsd: optionalNumber(row.last_price, 'priceUsd'),
    liquidityUsd: optionalNumber(row.last_liquidity_usd, 'liquidityUsd'),
    pairAddress: row.last_pair_address || null, pairUrl: row.last_pair_url || null,
    pairDexId: row.last_dex_id || null, imageUrl: row.last_image_url || null,
    twitterUrl: row.last_twitter_url || null, communityUrl: row.last_community_url || null,
    monitorPriority: row.monitor_priority || null,
    activityState: visibility.activityState, dataQuality: visibility.dataQuality,
    ...windowMetrics,
  });
}

async function hydrateMetrics(rows, query, windowRead, statementTimeoutMs) {
  const output = [];
  for (let offset = 0; offset < rows.length; offset += METRIC_BATCH_SIZE) {
    output.push(...await windowRead.getMetricsByAddresses({
      addresses: rows.slice(offset, offset + METRIC_BATCH_SIZE).map((row) => row.address),
      asOf: query.asOf, statementTimeoutMs,
    }));
  }
  const byAddress = new Map(output.map((item) => [normalizeTokenAddress(CHAIN, item.address), item]));
  return rows.map((row) => {
    const metrics = byAddress.get(normalizeTokenAddress(CHAIN, row.address));
    if (!metrics) throw new Error(`Solana radar metrics missing for ${row.address}`);
    return metrics;
  });
}

function createSolanaWorkspaceRadarReader(options = {}) {
  const database = options.database || db;
  const windowRead = options.windowRead || createSolanaWorkspaceWindowReadRepository({ database });
  async function listRadarPrefix(input = {}) {
    const query = normalizeRadarQuery({ ...input, chains: [CHAIN] });
    if (query.empty) return Object.freeze({ chain: CHAIN, asOf: query.asOf, total: 0, rows: [] });
    const statementTimeoutMs = timeoutMs(input.statementTimeoutMs);
    const dismissed = query.dismissedIdentities.map((identity) => identity.address);
    const starred = query.starredIdentities.map((identity) => identity.address);
    const params = [new Date(query.asOf), query.minMcap, query.maxMcap,
      query.ageMinMinutes, query.ageMaxMinutes, query.searchQuery ? `%${query.searchQuery}%` : null,
      dismissed, query.starredOnly, starred, query.requiredPrefix];
    const sql = buildCatalogSql(query.sorts);
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(sql, params, statementTimeoutMs)
      : await database.query(sql, params);
    const total = Number(result.rows[0]?.total_count) || 0;
    if (!Number.isSafeInteger(total) || result.rows.length !== Math.min(total, query.requiredPrefix)) {
      throw new Error('Solana radar prefix is incomplete');
    }
    const metrics = await hydrateMetrics(result.rows, query, windowRead, statementTimeoutMs);
    const rows = result.rows.map((row, index) => normalizeRow(row, metrics[index], query));
    for (let index = 1; index < rows.length; index += 1) {
      if (compareRadarRows(rows[index - 1], rows[index], query.sorts) > 0) {
        throw new Error('Solana radar prefix is not normalized-sort compatible');
      }
    }
    return Object.freeze({ chain: CHAIN, asOf: query.asOf, total, rows: Object.freeze(rows) });
  }

  async function getRadarTokensByAddresses(input = {}) {
    const addresses = [...new Set((input.addresses || []).map((address) => (
      normalizeTokenAddress(CHAIN, address)
    )))];
    if (addresses.length > 500) throw new Error('Solana radar pins cannot exceed 500 addresses');
    if (!addresses.length) return Object.freeze([]);
    const query = normalizeRadarQuery({ asOf: input.asOf, chains: [CHAIN], minMcap: 0 });
    const statementTimeoutMs = timeoutMs(input.statementTimeoutMs);
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(PINNED_SQL, [addresses], statementTimeoutMs)
      : await database.query(PINNED_SQL, [addresses]);
    const metrics = await hydrateMetrics(result.rows, query, windowRead, statementTimeoutMs);
    return Object.freeze(result.rows.map((row, index) => normalizeRow(
      row, metrics[index], query, { allowAnyAge: true, ignoreValuationFilter: true },
    )));
  }
  return Object.freeze({ getRadarTokensByAddresses, listRadarPrefix });
}

module.exports = {
  createSolanaWorkspaceRadarReader,
  __private: { PINNED_SQL, buildCatalogSql, buildOrderSql, normalizeRow },
};
