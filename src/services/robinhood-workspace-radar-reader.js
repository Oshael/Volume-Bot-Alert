const db = require('../models/db');
const { MARKET_COVERAGE_CTES } = require('../models/robinhood-market-coverage-sql');
const {
  createRobinhoodWorkspaceWindowReadRepository,
} = require('../models/robinhood-workspace-window-read');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const { evaluateWorkspaceVisibility } = require('./workspace-visibility-policy');
const {
  MAX_CATALOG_FDV_USD,
} = require('./robinhood-catalog-fdv-policy');
const {
  compareRadarRows,
  isRadarAgeInQuery,
  normalizeRadarQuery,
  resolveRadarTokenAge,
} = require('./dashboard-radar-query');

const CHAIN = 'robinhood';
const METRIC_BATCH_SIZE = 100;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const AGE_SQL = `COALESCE(NULLIF(tc.last_token_created_at_ms, 0),
  EXTRACT(EPOCH FROM tc.first_seen_at) * 1000)`;
const WINDOW_INTERVALS = Object.freeze({
  '1h': '1 hour', '6h': '6 hours', '24h': '24 hours',
});
const WINDOW_MINUTES = Object.freeze({
  '1h': 60, '6h': 6 * 60, '24h': 24 * 60,
});
const VOLUME_COLUMNS = Object.freeze({
  '1h': 'volume_1h_usd', '6h': 'volume_6h_usd', '24h': 'volume_24h_usd',
});

function coverageStateSql(window) {
  const interval = WINDOW_INTERVALS[window];
  return `CASE
    WHEN cursor.coverage_start_at IS NULL OR cursor.coverage_end_at IS NULL
      OR cursor.coverage_end_at <= cursor.coverage_start_at THEN 'unavailable'
    WHEN cursor.coverage_end_at <= $1::timestamptz - INTERVAL '${interval}'
      OR cursor.coverage_start_at >= $1::timestamptz THEN 'unavailable'
    WHEN cursor.coverage_start_at <= $1::timestamptz - INTERVAL '${interval}'
      AND cursor.coverage_end_at >= $1::timestamptz THEN 'complete'
    ELSE 'partial' END`;
}

function volumeValueSql(window) {
  return `CASE (${coverageStateSql(window)})
    WHEN 'complete' THEN COALESCE(activity.${VOLUME_COLUMNS[window]}, 0)
    WHEN 'partial' THEN activity.${VOLUME_COLUMNS[window]} ELSE NULL END`;
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
      clauses.push(`(${volumeValueSql(sort.window)}) DESC NULLS LAST`);
      clauses.push(`CASE (${coverageStateSql(sort.window)})
        WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END ASC`);
    } else if (sort.mode === 'pchange') {
      clauses.push(`${priceCoverageRankSql(sort.window)} ASC`);
      clauses.push(`(${priceValueSql(sort.window)}) DESC NULLS LAST`);
    } else if (sort.mode === 'mcap') {
      clauses.push(`valuation.last_fdv_usd ${sort.window === 'lowest' ? 'ASC' : 'DESC'} NULLS LAST`);
    } else {
      clauses.push(`${AGE_SQL} ${sort.window === 'oldest' ? 'ASC' : 'DESC'} NULLS LAST`);
    }
  }
  clauses.push('tc.address COLLATE "C" ASC');
  return clauses.join(',\n  ');
}

function resolveLargestActivityWindow(sorts) {
  return sorts.reduce((largest, sort) => {
    if (sort.mode !== 'vol') return largest;
    return !largest || WINDOW_MINUTES[sort.window] > WINDOW_MINUTES[largest]
      ? sort.window
      : largest;
  }, null);
}

function fullHourStartSql(window) {
  const windowStart = `$1::timestamptz - INTERVAL '${WINDOW_INTERVALS[window]}'`;
  return `date_trunc('hour', ${windowStart})
      + CASE WHEN ${windowStart} = date_trunc('hour', ${windowStart})
        THEN INTERVAL '0 hours' ELSE INTERVAL '1 hour' END`;
}

function buildActivityCteSql(sorts) {
  const largestWindow = resolveLargestActivityWindow(sorts);
  if (!largestWindow) return '';
  const windows = [...new Set(sorts.filter((sort) => sort.mode === 'vol')
    .map((sort) => sort.window))];
  const fullColumns = windows.map((window) => `SUM(bucket.volume_usd) FILTER (
      WHERE bucket.bucket_ts >= ${fullHourStartSql(window)}) AS volume_${window}_usd`).join(',\n    ');
  const startCtes = windows.map((window) => `, activity_start_${window} AS MATERIALIZED (
  SELECT bucket.token_address, SUM(bucket.volume_usd) AS volume_usd
  FROM robinhood_market_buckets_1m bucket
  JOIN catalog_candidates candidate ON candidate.address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '${WINDOW_INTERVALS[window]}'
    AND bucket.bucket_ts < ${fullHourStartSql(window)}
  GROUP BY bucket.token_address
)`).join('\n');
  const startJoins = windows.map((window) => (
    `LEFT JOIN activity_start_${window} ON activity_start_${window}.token_address = candidate.address`
  )).join('\n  ');
  const activityColumns = windows.map((window) => `CASE
      WHEN full_activity.volume_${window}_usd IS NULL
        AND activity_start_${window}.volume_usd IS NULL
        AND activity_end.volume_usd IS NULL THEN NULL
      ELSE COALESCE(full_activity.volume_${window}_usd, 0)
        + COALESCE(activity_start_${window}.volume_usd, 0)
        + COALESCE(activity_end.volume_usd, 0)
    END AS volume_${window}_usd`).join(',\n    ');
  return `, ${MARKET_COVERAGE_CTES}
, full_activity AS MATERIALIZED (
  SELECT bucket.token_address,
    ${fullColumns}
  FROM robinhood_market_buckets_1h bucket
  JOIN catalog_candidates candidate ON candidate.address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= ${fullHourStartSql(largestWindow)}
    AND bucket.bucket_ts < date_trunc('hour', $1::timestamptz)
  GROUP BY bucket.token_address
)
${startCtes}
, activity_end AS MATERIALIZED (
  SELECT bucket.token_address, SUM(bucket.volume_usd) AS volume_usd
  FROM robinhood_market_buckets_1m bucket
  JOIN catalog_candidates candidate ON candidate.address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= date_trunc('hour', $1::timestamptz)
    AND bucket.bucket_ts < $1::timestamptz
  GROUP BY bucket.token_address
), activity AS MATERIALIZED (
  SELECT candidate.address AS token_address,
    ${activityColumns}
  FROM catalog_candidates candidate
  LEFT JOIN full_activity ON full_activity.token_address = candidate.address
  ${startJoins}
  LEFT JOIN activity_end ON activity_end.token_address = candidate.address
)`;
}

function buildPriceJoinSql(sorts) {
  if (!sorts.some((sort) => sort.mode === 'pchange')) return '';
  const priceColumns = ['1h', '6h', '24h'].map((window) => `(array_agg(
      bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <=
        $1::timestamptz - INTERVAL '${window}' AND bucket.last_observed_at >=
        $1::timestamptz - INTERVAL '${window}' - INTERVAL '15 minutes'))[1]
      AS price_${window},
    (array_agg(bucket.last_observed_at ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at <=
        $1::timestamptz - INTERVAL '${window}' AND bucket.last_observed_at >=
        $1::timestamptz - INTERVAL '${window}' - INTERVAL '15 minutes'))[1]
      AS price_${window}_observed_at`).join(',\n    ');
  return `LEFT JOIN LATERAL (SELECT bucket.protocol, bucket.market_key
  FROM robinhood_market_buckets_1m bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '24 hours'
    AND bucket.bucket_ts < $1::timestamptz
  GROUP BY bucket.protocol, bucket.market_key
  ORDER BY SUM(bucket.volume_usd) DESC, MAX(bucket.last_observed_at) DESC,
    bucket.protocol, bucket.market_key LIMIT 1) primary_market ON TRUE
LEFT JOIN LATERAL (SELECT
    (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at >=
        $1::timestamptz - INTERVAL '15 minutes'
        AND bucket.last_observed_at < $1::timestamptz))[1] AS current_price,
    (array_agg(bucket.last_observed_at ORDER BY bucket.last_block_number DESC,
      bucket.last_log_index DESC) FILTER (WHERE bucket.last_observed_at >=
        $1::timestamptz - INTERVAL '15 minutes'
        AND bucket.last_observed_at < $1::timestamptz))[1] AS current_observed_at,
    ${priceColumns}
  FROM robinhood_market_buckets_1m bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol = primary_market.protocol
    AND bucket.market_key = primary_market.market_key
    AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '24 hours 15 minutes'
    AND bucket.bucket_ts < $1::timestamptz
  ) prices ON TRUE`;
}

function buildCatalogSql(sorts) {
  const hasVolumeSort = Boolean(resolveLargestActivityWindow(sorts));
  const hasPriceChangeSort = sorts.some((sort) => sort.mode === 'pchange');
  return `WITH catalog_candidates AS MATERIALIZED (
  SELECT tc.*
  FROM token_catalog tc
  WHERE tc.chain = 'robinhood'
    AND (
      tc.last_seen_at IS NULL
      OR tc.last_seen_at > $1::timestamptz
      OR tc.last_fdv IS NULL
      OR (tc.last_fdv >= $2::numeric
        AND ($3::numeric IS NULL OR tc.last_fdv <= $3::numeric))
    )
    AND ((${AGE_SQL}) IS NOT NULL
      AND (${AGE_SQL}) <= EXTRACT(EPOCH FROM $1::timestamptz) * 1000 - $4::numeric * 60000
      AND ($5::numeric IS NULL OR (${AGE_SQL}) >=
        EXTRACT(EPOCH FROM $1::timestamptz) * 1000 - $5::numeric * 60000))
    AND ($6::text IS NULL OR LOWER(COALESCE(tc.symbol, '') || ' '
      || COALESCE(tc.name, '') || ' ' || tc.address) LIKE $6::text)
    AND tc.address <> ALL($7::varchar[])
    AND ($8::boolean = FALSE OR tc.address = ANY($9::varchar[]))
    AND NOT EXISTS (SELECT 1 FROM admin_blocked_tokens blocked
      WHERE blocked.chain = 'robinhood' AND blocked.address = tc.address)
)
${buildActivityCteSql(sorts)}
SELECT tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_seen_at, tc.last_evaluated_at, tc.last_token_created_at_ms,
  valuation.last_fdv_usd, valuation.valuation_observed_at, tc.last_price, tc.last_liquidity_usd,
  tc.last_pair_address, tc.last_pair_url, tc.last_dex_id, tc.last_image_url,
  tc.launchpad_id,
  tc.last_twitter_url, tc.last_community_url, tc.monitor_priority,
  COUNT(*) OVER() AS total_count
FROM catalog_candidates tc
${hasVolumeSort ? `LEFT JOIN market_cursor cursor ON TRUE
LEFT JOIN activity ON activity.token_address = tc.address` : ''}
${hasPriceChangeSort ? buildPriceJoinSql(sorts) : ''}
LEFT JOIN LATERAL (SELECT bucket.close_fdv_usd AS last_fdv_usd,
    bucket.last_observed_at AS valuation_observed_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.last_observed_at <= $1::timestamptz AND bucket.close_fdv_usd > 0
  ORDER BY bucket.bucket_ts DESC, bucket.last_observed_at DESC,
    bucket.last_block_number DESC, bucket.last_log_index DESC,
    bucket.protocol, bucket.market_key LIMIT 1) valuation ON TRUE
WHERE ((valuation.last_fdv_usd IS NULL AND $2::numeric = 0)
    OR (valuation.last_fdv_usd >= $2::numeric
      AND ($3::numeric IS NULL OR valuation.last_fdv_usd <= $3::numeric)))
  AND (valuation.last_fdv_usd IS NULL
    OR valuation.last_fdv_usd < ${MAX_CATALOG_FDV_USD})
ORDER BY ${buildOrderSql(sorts)}
LIMIT $10::int`;
}

const PINNED_SQL = `SELECT tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_seen_at, tc.last_evaluated_at, tc.last_token_created_at_ms,
  valuation.last_fdv_usd, valuation.valuation_observed_at, tc.last_price, tc.last_liquidity_usd,
  tc.last_pair_address, tc.last_pair_url, tc.last_dex_id, tc.last_image_url,
  tc.launchpad_id,
  tc.last_twitter_url, tc.last_community_url, tc.monitor_priority
FROM token_catalog tc
LEFT JOIN LATERAL (SELECT bucket.close_fdv_usd AS last_fdv_usd,
    bucket.last_observed_at AS valuation_observed_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.last_observed_at <= $1::timestamptz AND bucket.close_fdv_usd > 0
  ORDER BY bucket.last_observed_at DESC, bucket.last_block_number DESC,
    bucket.last_log_index DESC, bucket.protocol ASC, bucket.market_key ASC LIMIT 1) valuation ON TRUE
WHERE tc.chain = 'robinhood' AND tc.address = ANY($2::varchar[])
  AND (valuation.last_fdv_usd IS NULL
    OR valuation.last_fdv_usd < ${MAX_CATALOG_FDV_USD})
  AND NOT EXISTS (SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'robinhood' AND blocked.address = tc.address)
ORDER BY array_position($2::varchar[], tc.address)`;

function timeoutMs(value) {
  const parsed = Number(value ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 60_000) {
    throw new Error('Robinhood radar timeout must be between 1000 and 60000');
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
  const observedAt = optionalIso(row.valuation_observed_at, 'valuation observedAt');
  const visibility = evaluateWorkspaceVisibility({
    identity, state: { lastActivityAt: metrics.lastActivityAt },
    valuation: { type: 'fdv', usd: row.last_fdv_usd, observedAt },
    filters: { minValuationUsd: options.ignoreValuationFilter ? 0 : query.minFdv,
      maxValuationUsd: options.ignoreValuationFilter ? null : query.maxFdv },
  }, { nowMs: new Date(query.asOf).getTime() });
  if (!visibility.visible) throw new Error(`${identity.key} violates its radar filter`);
  const { chain: _chain, address: _address, key: _key, ...windowMetrics } = metrics;
  return Object.freeze({
    identity, tokenAge, symbol: row.symbol || null, name: row.name || null,
    source: row.source || 'unknown', firstSeenAt: optionalIso(row.first_seen_at, 'firstSeenAt'),
    lastSeenAt: optionalIso(row.last_seen_at, 'lastSeenAt'),
    lastEvaluatedAt: optionalIso(row.last_evaluated_at, 'lastEvaluatedAt'),
    valuation: visibility.valuation, priceUsd: optionalNumber(row.last_price, 'priceUsd'),
    liquidityUsd: optionalNumber(row.last_liquidity_usd, 'liquidityUsd'),
    pairUrl: row.last_pair_url || null, pairDexId: row.last_dex_id || null,
    imageUrl: row.last_image_url || null, launchpadId: row.launchpad_id || null,
    twitterUrl: row.last_twitter_url || null,
    communityUrl: row.last_community_url || null, monitorPriority: row.monitor_priority || null,
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
    if (!metrics) throw new Error(`Robinhood radar metrics missing for ${row.address}`);
    return metrics;
  });
}

function createRobinhoodWorkspaceRadarReader(options = {}) {
  const database = options.database || db;
  const windowRead = options.windowRead || createRobinhoodWorkspaceWindowReadRepository({ database });
  async function listRadarPrefix(input = {}) {
    const query = normalizeRadarQuery({ ...input, chains: [CHAIN] });
    if (query.empty) return Object.freeze({ chain: CHAIN, asOf: query.asOf, total: 0, rows: [] });
    const statementTimeoutMs = timeoutMs(input.statementTimeoutMs);
    const dismissed = query.dismissedIdentities.map((identity) => identity.address);
    const starred = query.starredIdentities.map((identity) => identity.address);
    const params = [new Date(query.asOf), query.minFdv, query.maxFdv,
      query.ageMinMinutes, query.ageMaxMinutes, query.searchQuery ? `%${query.searchQuery}%` : null,
      dismissed, query.starredOnly, starred, query.requiredPrefix];
    const sql = buildCatalogSql(query.sorts);
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(sql, params, statementTimeoutMs)
      : await database.query(sql, params);
    const total = Number(result.rows[0]?.total_count) || 0;
    if (!Number.isSafeInteger(total) || result.rows.length !== Math.min(total, query.requiredPrefix)) {
      throw new Error('Robinhood radar prefix is incomplete');
    }
    const metrics = await hydrateMetrics(result.rows, query, windowRead, statementTimeoutMs);
    const rows = result.rows.map((row, index) => normalizeRow(row, metrics[index], query));
    for (let index = 1; index < rows.length; index += 1) {
      if (compareRadarRows(rows[index - 1], rows[index], query.sorts) > 0) {
        throw new Error('Robinhood radar prefix is not normalized-sort compatible');
      }
    }
    return Object.freeze({ chain: CHAIN, asOf: query.asOf, total, rows: Object.freeze(rows) });
  }

  async function getRadarTokensByAddresses(input = {}) {
    const addresses = [...new Set((input.addresses || []).map((address) => (
      normalizeTokenAddress(CHAIN, address)
    )))];
    if (addresses.length > 500) throw new Error('Robinhood radar pins cannot exceed 500 addresses');
    if (!addresses.length) return Object.freeze([]);
    const query = normalizeRadarQuery({ asOf: input.asOf, chains: [CHAIN], minFdv: 0 });
    const statementTimeoutMs = timeoutMs(input.statementTimeoutMs);
    const params = [new Date(query.asOf), addresses];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(PINNED_SQL, params, statementTimeoutMs)
      : await database.query(PINNED_SQL, params);
    const metrics = await hydrateMetrics(result.rows, query, windowRead, statementTimeoutMs);
    return Object.freeze(result.rows.map((row, index) => normalizeRow(
      row, metrics[index], query, { allowAnyAge: true, ignoreValuationFilter: true },
    )));
  }
  return Object.freeze({ getRadarTokensByAddresses, listRadarPrefix });
}

module.exports = {
  createRobinhoodWorkspaceRadarReader,
  __private: { PINNED_SQL, buildCatalogSql, buildOrderSql, normalizeRow },
};
