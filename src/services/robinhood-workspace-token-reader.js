const db = require('../models/db');
const {
  createRobinhoodWorkspaceWindowReadRepository,
} = require('../models/robinhood-workspace-window-read');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const { evaluateWorkspaceVisibility } = require('./workspace-visibility-policy');
const {
  compareNormalizedMonitoredRows,
  normalizeMonitoredQuery,
} = require('./dashboard-chain-aggregation');

const CHAIN = 'robinhood';
const DEFAULT_MIN_FDV = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const METRIC_BATCH_SIZE = 100;
const MAX_EXCLUDED_ADDRESSES = 5000;
const MAX_REQUESTED_ADDRESSES = 500;
const AGE_SQL = `COALESCE(
  NULLIF(tc.last_token_created_at_ms, 0),
  EXTRACT(EPOCH FROM tc.first_seen_at) * 1000
)`;
const WINDOW_INTERVALS = Object.freeze({
  '5m': '5 minutes', '1h': '1 hour', '6h': '6 hours', '24h': '24 hours',
});
const WINDOW_MINUTES = Object.freeze({
  '5m': 5, '1h': 60, '6h': 6 * 60, '24h': 24 * 60,
});
const VOLUME_COLUMNS = Object.freeze({
  '5m': 'volume_5m_usd', '1h': 'volume_1h_usd',
  '6h': 'volume_6h_usd', '24h': 'volume_24h_usd',
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
    ELSE 'partial'
  END`;
}

function volumeValueSql(window) {
  const column = VOLUME_COLUMNS[window];
  const coverage = coverageStateSql(window);
  return `CASE (${coverage})
    WHEN 'complete' THEN COALESCE(activity.${column}, 0)
    WHEN 'partial' THEN activity.${column}
    ELSE NULL
  END`;
}

function buildOrderSql(sorts) {
  const clauses = [];
  for (const sort of sorts) {
    if (sort.mode === 'vol') {
      const value = volumeValueSql(sort.window);
      const coverage = coverageStateSql(sort.window);
      clauses.push(`CASE WHEN (${value}) IS NULL THEN 2
        WHEN (${coverage}) = 'complete' THEN 0 ELSE 1 END ASC`);
      clauses.push(`(${value}) DESC NULLS LAST`);
    } else if (sort.mode === 'mcap') {
      clauses.push(`valuation.last_fdv_usd ${sort.window === 'lowest' ? 'ASC' : 'DESC'} NULLS LAST`);
    } else {
      clauses.push(`${AGE_SQL} ${sort.window === 'oldest' ? 'ASC' : 'DESC'} NULLS LAST`);
    }
  }
  clauses.push(`${AGE_SQL} DESC NULLS LAST`);
  clauses.push('valuation.last_fdv_usd DESC NULLS LAST');
  clauses.push('tc.address COLLATE "C" ASC');
  return clauses.join(',\n  ');
}

function buildActivityJoinSql(sorts) {
  const largestWindow = sorts.reduce((largest, sort) => {
    if (sort.mode !== 'vol') return largest;
    return !largest || WINDOW_MINUTES[sort.window] > WINDOW_MINUTES[largest]
      ? sort.window
      : largest;
  }, null);
  if (!largestWindow) return '';
  return `LEFT JOIN LATERAL (
  SELECT
    SUM(bucket.volume_usd) FILTER (WHERE bucket.bucket_ts >= $1::timestamptz
      - INTERVAL '5 minutes') AS volume_5m_usd,
    SUM(bucket.volume_usd) FILTER (WHERE bucket.bucket_ts >= $1::timestamptz
      - INTERVAL '1 hour') AS volume_1h_usd,
    SUM(bucket.volume_usd) FILTER (WHERE bucket.bucket_ts >= $1::timestamptz
      - INTERVAL '6 hours') AS volume_6h_usd,
    SUM(bucket.volume_usd) AS volume_24h_usd
  FROM robinhood_market_buckets_1m bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '${WINDOW_INTERVALS[largestWindow]}'
    AND bucket.bucket_ts < $1::timestamptz
) activity ON TRUE`;
}

function buildPrefixSql(sorts) {
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
    AND tc.address <> ALL($4::varchar[])
    AND NOT EXISTS (
      SELECT 1 FROM admin_blocked_tokens blocked
      WHERE blocked.chain = 'robinhood' AND blocked.address = tc.address
    )
)
SELECT
  tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_token_created_at_ms, valuation.last_fdv_usd,
  valuation.valuation_observed_at, tc.last_price, tc.last_pair_address,
  tc.last_pair_url, tc.last_dex_id, tc.last_image_url,
  tc.last_twitter_url, tc.last_community_url, tc.monitor_priority,
  tc.last_seen_at, tc.last_evaluated_at, COUNT(*) OVER() AS total_count
FROM catalog_candidates tc
LEFT JOIN LATERAL (
  SELECT coverage_start_timestamp AS coverage_start_at,
    checkpoint_timestamp AS coverage_end_at
  FROM robinhood_ingestion_cursors
  WHERE chain = 'robinhood' AND stream = 'market'
  LIMIT 1
) cursor ON TRUE
${buildActivityJoinSql(sorts)}
LEFT JOIN LATERAL (
  SELECT bucket.close_fdv_usd AS last_fdv_usd,
    bucket.last_observed_at AS valuation_observed_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.last_observed_at <= $1::timestamptz AND bucket.close_fdv_usd > 0
  ORDER BY bucket.last_observed_at DESC, bucket.last_block_number DESC,
    bucket.last_log_index DESC, bucket.protocol ASC, bucket.market_key ASC
  LIMIT 1
) valuation ON TRUE
WHERE tc.chain = 'robinhood'
  AND ((valuation.last_fdv_usd IS NULL AND $2::numeric = 0)
    OR (valuation.last_fdv_usd >= $2::numeric
      AND ($3::numeric IS NULL OR valuation.last_fdv_usd <= $3::numeric)))
ORDER BY ${buildOrderSql(sorts)}
LIMIT $5::int`;
}

const PINNED_SQL = `SELECT
  tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_token_created_at_ms, valuation.last_fdv_usd,
  valuation.valuation_observed_at, tc.last_price, tc.last_pair_address,
  tc.last_pair_url, tc.last_dex_id, tc.last_image_url,
  tc.last_twitter_url, tc.last_community_url, tc.monitor_priority,
  tc.last_seen_at, tc.last_evaluated_at
FROM token_catalog tc
LEFT JOIN LATERAL (
  SELECT bucket.close_fdv_usd AS last_fdv_usd,
    bucket.last_observed_at AS valuation_observed_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.last_observed_at <= $1::timestamptz AND bucket.close_fdv_usd > 0
  ORDER BY bucket.last_observed_at DESC, bucket.last_block_number DESC,
    bucket.last_log_index DESC, bucket.protocol ASC, bucket.market_key ASC
  LIMIT 1
) valuation ON TRUE
WHERE tc.chain = 'robinhood'
  AND tc.address = ANY($2::varchar[])
  AND NOT EXISTS (
    SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'robinhood' AND blocked.address = tc.address
  )
ORDER BY array_position($2::varchar[], tc.address)`;

function normalizeFdv(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new RangeError(`${label} is invalid`);
  return parsed;
}

function normalizeFilters(input) {
  const minFdv = normalizeFdv(input.minFdv, DEFAULT_MIN_FDV, 'minFdv');
  const rawMax = normalizeFdv(input.maxFdv, null, 'maxFdv');
  const maxFdv = rawMax === 0 ? null : rawMax;
  if (maxFdv != null && maxFdv < minFdv) {
    throw new RangeError('maxFdv must be greater than or equal to minFdv');
  }
  return Object.freeze({ minFdv, maxFdv });
}

function normalizeExcludedAddresses(values) {
  if (values != null && !Array.isArray(values)) {
    throw new TypeError('excludedAddresses must be an array');
  }
  const addresses = [...new Set((values || []).map((value) => (
    normalizeTokenAddress(CHAIN, value)
  )))];
  if (addresses.length > MAX_EXCLUDED_ADDRESSES) {
    throw new RangeError(`excludedAddresses cannot exceed ${MAX_EXCLUDED_ADDRESSES}`);
  }
  return Object.freeze(addresses);
}

function normalizeRequestedAddresses(values) {
  if (!Array.isArray(values)) throw new TypeError('addresses must be an array');
  const addresses = [...new Set(values.map((value) => normalizeTokenAddress(CHAIN, value)))];
  if (addresses.length > MAX_REQUESTED_ADDRESSES) {
    throw new RangeError(`addresses cannot exceed ${MAX_REQUESTED_ADDRESSES}`);
  }
  return Object.freeze(addresses);
}

function normalizeTimeout(value) {
  const parsed = Number(value ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 60_000) {
    throw new RangeError('statementTimeoutMs must be between 1000 and 60000');
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

function optionalText(value) {
  return value == null || value === '' ? null : String(value);
}

function normalizeTokenAge(row) {
  const native = Number(row.last_token_created_at_ms);
  if (Number.isFinite(native) && native > 0) return { value: native, source: 'chain-native' };
  const firstSeenAt = optionalIso(row.first_seen_at, 'firstSeenAt');
  return {
    value: firstSeenAt == null ? null : new Date(firstSeenAt).getTime(),
    source: firstSeenAt == null ? 'unknown' : 'first-seen',
  };
}

function normalizeCatalogRow(row, metrics, query, filters) {
  const identity = createTokenIdentity(CHAIN, row.address);
  const observedAt = optionalIso(row.valuation_observed_at, 'valuation observedAt');
  const visibility = evaluateWorkspaceVisibility({
    identity,
    state: { lastActivityAt: metrics.lastActivityAt },
    valuation: { type: 'fdv', usd: row.last_fdv_usd, observedAt },
    filters: { minValuationUsd: filters.minFdv, maxValuationUsd: filters.maxFdv },
  }, { nowMs: new Date(query.asOf).getTime() });
  if (!visibility.visible) throw new Error(`${identity.key} violates its SQL visibility filter`);

  const age = normalizeTokenAge(row);
  const { chain: _chain, address: _address, key: _key, ...windowMetrics } = metrics;
  return Object.freeze({
    identity,
    symbol: optionalText(row.symbol),
    name: optionalText(row.name),
    source: String(row.source || 'unknown'),
    firstSeenAt: optionalIso(row.first_seen_at, 'firstSeenAt'),
    lastSeenAt: optionalIso(row.last_seen_at, 'lastSeenAt'),
    lastEvaluatedAt: optionalIso(row.last_evaluated_at, 'lastEvaluatedAt'),
    tokenCreatedAt: age.value,
    tokenAgeProvenance: age.source,
    priceUsd: optionalNumber(row.last_price, 'priceUsd'),
    liquidityUsd: null,
    pairAddress: optionalText(row.last_pair_address),
    pairUrl: optionalText(row.last_pair_url),
    pairDexId: optionalText(row.last_dex_id),
    imageUrl: optionalText(row.last_image_url),
    twitterUrl: optionalText(row.last_twitter_url),
    communityUrl: optionalText(row.last_community_url),
    monitorPriority: optionalText(row.monitor_priority),
    valuation: visibility.valuation,
    activityState: visibility.activityState,
    riskState: visibility.riskState,
    dataQuality: visibility.dataQuality,
    ...windowMetrics,
  });
}

function validateCandidateCount(rows, requiredPrefix) {
  if (!rows.length) return 0;
  const totals = new Set(rows.map((row) => Number(row.total_count)));
  const total = [...totals][0];
  if (totals.size !== 1 || !Number.isSafeInteger(total) || total < 0) {
    throw new Error('Robinhood monitored total is inconsistent');
  }
  const required = Math.min(total, requiredPrefix);
  if (rows.length !== required) {
    throw new Error(`Robinhood prefix returned ${rows.length} rows; ${required} required`);
  }
  return total;
}

async function hydrateMetrics(rows, query, windowRead, timeoutMs) {
  const hydrated = [];
  for (let offset = 0; offset < rows.length; offset += METRIC_BATCH_SIZE) {
    const addresses = rows.slice(offset, offset + METRIC_BATCH_SIZE).map((row) => row.address);
    hydrated.push(...await windowRead.getMetricsByAddresses({
      addresses, asOf: query.asOf, statementTimeoutMs: timeoutMs,
    }));
  }
  if (hydrated.length !== rows.length) {
    throw new Error(`Robinhood metric hydration returned ${hydrated.length} rows; ${rows.length} required`);
  }
  const byIdentity = new Map(hydrated.map((row) => [
    createTokenIdentity(row.chain, row.address).key, row,
  ]));
  return rows.map((row) => {
    const metrics = byIdentity.get(createTokenIdentity(CHAIN, row.address).key);
    if (!metrics) throw new Error(`Robinhood metrics missing for ${row.address}`);
    return metrics;
  });
}

function createRobinhoodWorkspaceTokenReader(options = {}) {
  const database = options.database || db;
  const windowRead = options.windowRead
    || createRobinhoodWorkspaceWindowReadRepository({ database });

  async function listMonitoredPrefix(input = {}) {
    const query = normalizeMonitoredQuery(input);
    const filters = normalizeFilters(input);
    const excludedAddresses = normalizeExcludedAddresses(input.excludedAddresses);
    const timeoutMs = normalizeTimeout(input.statementTimeoutMs);
    const sql = buildPrefixSql(query.sorts);
    const params = [new Date(query.asOf), filters.minFdv, filters.maxFdv,
      excludedAddresses, query.requiredPrefix];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(sql, params, timeoutMs)
      : await database.query(sql, params);
    const excluded = new Set(excludedAddresses);
    if (result.rows.some((row) => excluded.has(normalizeTokenAddress(CHAIN, row.address)))) {
      throw new Error('Robinhood SQL prefix contains a user-excluded identity');
    }
    const total = validateCandidateCount(result.rows, query.requiredPrefix);
    const metrics = await hydrateMetrics(result.rows, query, windowRead, timeoutMs);
    const rows = result.rows.map((row, index) => (
      normalizeCatalogRow(row, metrics[index], query, filters)
    ));
    for (let index = 1; index < rows.length; index += 1) {
      if (compareNormalizedMonitoredRows(rows[index - 1], rows[index], query.sorts) > 0) {
        throw new Error('Robinhood SQL prefix is not normalized-sort compatible');
      }
    }
    return Object.freeze({
      chain: CHAIN, asOf: query.asOf, total, rows: Object.freeze(rows),
    });
  }

  async function getTokensByAddresses(input = {}) {
    const addresses = normalizeRequestedAddresses(input.addresses);
    if (!addresses.length) return Object.freeze([]);
    const query = normalizeMonitoredQuery({ asOf: input.asOf, page: 0, perPage: 1 });
    const timeoutMs = normalizeTimeout(input.statementTimeoutMs);
    const params = [new Date(query.asOf), addresses];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(PINNED_SQL, params, timeoutMs)
      : await database.query(PINNED_SQL, params);
    const requested = new Set(addresses);
    const returned = new Set();
    for (const row of result.rows) {
      const address = normalizeTokenAddress(CHAIN, row.address);
      if (!requested.has(address) || returned.has(address)) {
        throw new Error('Robinhood pinned query returned an invalid identity set');
      }
      returned.add(address);
    }
    const metrics = await hydrateMetrics(result.rows, query, windowRead, timeoutMs);
    return Object.freeze(result.rows.map((row, index) => normalizeCatalogRow(
      row, metrics[index], query, { minFdv: 0, maxFdv: null },
    )));
  }

  return Object.freeze({ getTokensByAddresses, listMonitoredPrefix });
}

module.exports = {
  createRobinhoodWorkspaceTokenReader,
  __private: {
    PINNED_SQL, buildOrderSql, buildPrefixSql, normalizeCatalogRow,
    normalizeExcludedAddresses, normalizeFilters,
  },
};
