const db = require('../models/db');
const { MARKET_COVERAGE_CTES } = require('../models/robinhood-market-coverage-sql');
const {
  createRobinhoodWorkspaceWindowReadRepository,
} = require('../models/robinhood-workspace-window-read');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const {
  normalizeRobinhoodHolderSummary,
} = require('../utils/robinhood-holder-summary-view');
const { evaluateWorkspaceVisibility } = require('./workspace-visibility-policy');
const {
  MAX_CATALOG_FDV_USD,
} = require('./robinhood-catalog-fdv-policy');
const {
  compareNormalizedMonitoredRows,
  normalizeMonitoredQuery,
} = require('./dashboard-chain-aggregation');

const CHAIN = 'robinhood';
const DEFAULT_MIN_FDV = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const METRIC_BATCH_SIZE = 100;
const PREFIX_CACHE_LIMIT = 500;
const PREFIX_CACHE_MAX_ENTRIES = 8;
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
  const windows = [...new Set(sorts.filter((sort) => sort.mode === 'vol')
    .map((sort) => sort.window))];
  if (!windows.length) return '';
  return `LEFT JOIN market_cursor cursor ON TRUE
LEFT JOIN activity ON activity.token_address = tc.address`;
}

function buildActivityCteSql(sorts) {
  const windows = [...new Set(sorts.filter((sort) => sort.mode === 'vol')
    .map((sort) => sort.window))];
  const largestWindow = windows.reduce((largest, window) => {
    return !largest || WINDOW_MINUTES[window] > WINDOW_MINUTES[largest]
      ? window
      : largest;
  }, null);
  if (!largestWindow) return '';
  const columns = windows.map((window) => `SUM(bucket.volume_usd) FILTER (
      WHERE bucket.bucket_ts >= $1::timestamptz
        - INTERVAL '${WINDOW_INTERVALS[window]}') AS ${VOLUME_COLUMNS[window]}`).join(',\n    ');
  return `, ${MARKET_COVERAGE_CTES}
, activity AS MATERIALIZED (
  SELECT bucket.token_address,
    ${columns}
  FROM robinhood_market_buckets_1m bucket
  INNER JOIN catalog_candidates candidate ON candidate.address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= $1::timestamptz - INTERVAL '${WINDOW_INTERVALS[largestWindow]}'
    AND bucket.bucket_ts < $1::timestamptz
  GROUP BY bucket.token_address
)`;
}

function buildActivitySelectSql(sorts) {
  const windows = [...new Set(sorts.filter((sort) => sort.mode === 'vol')
    .map((sort) => sort.window))];
  return windows.flatMap((window) => [
    `activity.${VOLUME_COLUMNS[window]} AS ranking_${VOLUME_COLUMNS[window]}`,
    `(${coverageStateSql(window)}) AS ranking_coverage_${window}`,
  ]).join(',\n  ');
}

function buildValuationJoinSql(preferCatalogValuation) {
  if (preferCatalogValuation) {
    return `LEFT JOIN LATERAL (
  SELECT tc.last_fdv AS last_fdv_usd,
    tc.last_seen_at AS valuation_observed_at
) valuation ON TRUE`;
  }
  return `LEFT JOIN LATERAL (
  SELECT bucket.close_fdv_usd AS last_fdv_usd,
    bucket.last_observed_at AS valuation_observed_at
  FROM robinhood_market_buckets_1h bucket
  WHERE bucket.chain = 'robinhood' AND bucket.token_address = tc.address
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.last_observed_at <= $1::timestamptz AND bucket.close_fdv_usd > 0
  ORDER BY bucket.bucket_ts DESC, bucket.last_observed_at DESC,
    bucket.last_block_number DESC, bucket.last_log_index DESC,
    bucket.protocol ASC, bucket.market_key ASC
  LIMIT 1
) valuation ON TRUE`;
}

function buildPrefixSql(sorts, options = {}) {
  const activitySelect = buildActivitySelectSql(sorts);
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
${buildActivityCteSql(sorts)}
SELECT
  tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_token_created_at_ms, valuation.last_fdv_usd,
  valuation.valuation_observed_at, tc.last_price, tc.last_liquidity_usd, tc.last_pair_address,
  tc.last_pair_url, tc.last_dex_id, tc.last_image_url, tc.launchpad_id,
  tc.last_twitter_url, tc.last_community_url, tc.monitor_priority,
  tc.last_seen_at, tc.last_evaluated_at,
  holder_summary.holder_count, holder_summary.source AS holder_source,
  holder_summary.observed_at AS holder_observed_at,
  holder_summary.checked_at AS holder_checked_at${activitySelect ? `,
  ${activitySelect}` : ''}, COUNT(*) OVER() AS total_count
FROM catalog_candidates tc
${buildActivityJoinSql(sorts)}
${buildValuationJoinSql(options.preferCatalogValuation === true)}
LEFT JOIN robinhood_published_holder_summaries holder_summary
  ON holder_summary.chain = 'robinhood' AND holder_summary.token_address = tc.address
WHERE tc.chain = 'robinhood'
  AND ((valuation.last_fdv_usd IS NULL AND $2::numeric = 0)
    OR (valuation.last_fdv_usd >= $2::numeric
      AND ($3::numeric IS NULL OR valuation.last_fdv_usd <= $3::numeric)))
  AND (valuation.last_fdv_usd IS NULL
    OR valuation.last_fdv_usd < ${MAX_CATALOG_FDV_USD})
ORDER BY ${buildOrderSql(sorts)}
LIMIT $5::int`;
}

const PINNED_SQL = `SELECT
  tc.address, tc.symbol, tc.name, tc.source, tc.first_seen_at,
  tc.last_token_created_at_ms, valuation.last_fdv_usd,
  valuation.valuation_observed_at, tc.last_price, tc.last_liquidity_usd, tc.last_pair_address,
  tc.last_pair_url, tc.last_dex_id, tc.last_image_url, tc.launchpad_id,
  tc.last_twitter_url, tc.last_community_url, tc.monitor_priority,
  tc.last_seen_at, tc.last_evaluated_at,
  holder_summary.holder_count, holder_summary.source AS holder_source,
  holder_summary.observed_at AS holder_observed_at,
  holder_summary.checked_at AS holder_checked_at
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
LEFT JOIN robinhood_published_holder_summaries holder_summary
  ON holder_summary.chain = 'robinhood' AND holder_summary.token_address = tc.address
WHERE tc.chain = 'robinhood'
  AND tc.address = ANY($2::varchar[])
  AND (valuation.last_fdv_usd IS NULL
    OR valuation.last_fdv_usd < ${MAX_CATALOG_FDV_USD})
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

function applyRankingMetrics(row, metrics, sorts) {
  const coverage = { ...metrics.coverage };
  const output = { ...metrics };
  for (const sort of sorts) {
    if (sort.mode !== 'vol') continue;
    const state = String(row[`ranking_coverage_${sort.window}`] || 'unavailable');
    const rawValue = row[`ranking_${VOLUME_COLUMNS[sort.window]}`];
    const parsed = rawValue == null ? null : Number(rawValue);
    if (!['complete', 'partial', 'unavailable'].includes(state)
      || (parsed != null && (!Number.isFinite(parsed) || parsed < 0))) {
      throw new Error(`Robinhood ${sort.window} ranking metric is invalid`);
    }
    coverage[sort.window] = state;
    output[`volume${sort.window}Usd`] = state === 'complete'
      ? (parsed ?? 0)
      : (state === 'partial' ? parsed : null);
  }
  return Object.freeze({ ...output, coverage: Object.freeze(coverage) });
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
  const {
    chain: _chain, address: _address, key: _key,
    liquidityUsd, liquidityCoverage, liquidityMarketCount,
    valuedLiquidityMarketCount, liquidityPools, ...windowMetrics
  } = metrics;
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
    liquidityUsd: optionalNumber(liquidityUsd, 'liquidityUsd'),
    liquidityCoverage,
    liquidityMarketCount,
    valuedLiquidityMarketCount,
    liquidityPools,
    pairAddress: optionalText(row.last_pair_address),
    pairUrl: optionalText(row.last_pair_url),
    pairDexId: optionalText(row.last_dex_id),
    imageUrl: optionalText(row.last_image_url),
    launchpadId: optionalText(row.launchpad_id),
    twitterUrl: optionalText(row.last_twitter_url),
    communityUrl: optionalText(row.last_community_url),
    monitorPriority: optionalText(row.monitor_priority),
    valuation: visibility.valuation,
    activityState: visibility.activityState,
    riskState: visibility.riskState,
    dataQuality: visibility.dataQuality,
    ...normalizeRobinhoodHolderSummary(row, query.asOf),
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

async function hydrateMetrics(rows, query, windowRead, timeoutMs, cache = new Map()) {
  const missingRows = rows.filter((row) => (
    !cache.has(createTokenIdentity(CHAIN, row.address).key)
  ));
  const hydrated = [];
  for (let offset = 0; offset < missingRows.length; offset += METRIC_BATCH_SIZE) {
    const addresses = missingRows.slice(offset, offset + METRIC_BATCH_SIZE)
      .map((row) => row.address);
    hydrated.push(...await windowRead.getMetricsByAddresses({
      addresses, asOf: query.asOf, statementTimeoutMs: timeoutMs,
    }));
  }
  if (hydrated.length !== missingRows.length) {
    throw new Error(`Robinhood metric hydration returned ${hydrated.length} rows; ${missingRows.length} required`);
  }
  for (const row of hydrated) {
    cache.set(createTokenIdentity(row.chain, row.address).key, row);
  }
  return rows.map((row) => {
    const metrics = cache.get(createTokenIdentity(CHAIN, row.address).key);
    if (!metrics) throw new Error(`Robinhood metrics missing for ${row.address}`);
    return metrics;
  });
}

function buildPrefixCacheKey(query, filters, excludedAddresses, preferCatalogValuation) {
  return JSON.stringify({
    asOf: query.asOf,
    sorts: query.sorts,
    minFdv: filters.minFdv,
    maxFdv: filters.maxFdv,
    excludedAddresses: [...excludedAddresses].sort(),
    preferCatalogValuation,
  });
}

function createRobinhoodWorkspaceTokenReader(options = {}) {
  const database = options.database || db;
  const windowRead = options.windowRead
    || createRobinhoodWorkspaceWindowReadRepository({ database });
  const prefixCache = new Map();

  function getCachedPrefix(key) {
    const entry = prefixCache.get(key);
    if (!entry) return null;
    prefixCache.delete(key);
    prefixCache.set(key, entry);
    return entry;
  }

  function setCachedPrefix(key, entry) {
    prefixCache.set(key, entry);
    while (prefixCache.size > PREFIX_CACHE_MAX_ENTRIES) {
      prefixCache.delete(prefixCache.keys().next().value);
    }
    return entry;
  }

  async function loadPrefixEntry(input) {
    const key = buildPrefixCacheKey(
      input.query, input.filters, input.excludedAddresses, input.preferCatalogValuation,
    );
    const cached = getCachedPrefix(key);
    if (cached) return cached;
    const sql = buildPrefixSql(input.query.sorts, {
      preferCatalogValuation: input.preferCatalogValuation,
    });
    const params = [new Date(input.query.asOf), input.filters.minFdv, input.filters.maxFdv,
      input.excludedAddresses, PREFIX_CACHE_LIMIT];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(sql, params, input.timeoutMs)
      : await database.query(sql, params);
    const excluded = new Set(input.excludedAddresses);
    if (result.rows.some((row) => excluded.has(normalizeTokenAddress(CHAIN, row.address)))) {
      throw new Error('Robinhood SQL prefix contains a user-excluded identity');
    }
    return setCachedPrefix(key, {
      rows: result.rows,
      total: validateCandidateCount(result.rows, PREFIX_CACHE_LIMIT),
      metricsByIdentity: new Map(),
    });
  }

  async function listMonitoredPrefix(input = {}) {
    const query = normalizeMonitoredQuery(input);
    const filters = normalizeFilters(input);
    const excludedAddresses = normalizeExcludedAddresses(input.excludedAddresses);
    const timeoutMs = normalizeTimeout(input.statementTimeoutMs);
    const entry = await loadPrefixEntry({
      query, filters, excludedAddresses, timeoutMs,
      preferCatalogValuation: input.preferCatalogValuation === true,
    });
    const required = Math.min(entry.total, query.requiredPrefix);
    const prefixRows = entry.rows.slice(0, required);
    if (prefixRows.length !== required) {
      throw new Error(`Robinhood cached prefix returned ${prefixRows.length} rows; ${required} required`);
    }
    const metrics = await hydrateMetrics(
      prefixRows, query, windowRead, timeoutMs, entry.metricsByIdentity,
    );
    const rows = prefixRows.map((row, index) => (
      normalizeCatalogRow(
        row, applyRankingMetrics(row, metrics[index], query.sorts), query, filters,
      )
    ));
    for (let index = 1; index < rows.length; index += 1) {
      if (compareNormalizedMonitoredRows(rows[index - 1], rows[index], query.sorts) > 0) {
        throw new Error('Robinhood SQL prefix is not normalized-sort compatible');
      }
    }
    return Object.freeze({
      chain: CHAIN, asOf: query.asOf, total: entry.total, rows: Object.freeze(rows),
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
    PINNED_SQL, applyRankingMetrics, buildActivityCteSql, buildOrderSql,
    buildPrefixCacheKey, buildPrefixSql, buildValuationJoinSql, normalizeCatalogRow,
    normalizeExcludedAddresses, normalizeFilters,
  },
};
