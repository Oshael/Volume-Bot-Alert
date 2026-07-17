const db = require('../models/db');
const {
  createSolanaWorkspaceWindowReadRepository,
} = require('../models/solana-workspace-window-read');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const { evaluateWorkspaceVisibility } = require('./workspace-visibility-policy');
const {
  compareNormalizedMonitoredRows,
  normalizeMonitoredQuery,
} = require('./dashboard-chain-aggregation');

const CHAIN = 'solana';
const DEFAULT_MIN_MCAP = 30_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const METRIC_BATCH_SIZE = 100;
const MAX_EXCLUDED_ADDRESSES = 5000;
const MAX_REQUESTED_ADDRESSES = 500;
const AGE_SQL = `COALESCE(
  NULLIF(tc.last_token_created_at_ms, 0),
  EXTRACT(EPOCH FROM tc.first_seen_at) * 1000
)`;
const VOLUME_COLUMNS = Object.freeze({
  '5m': 'close_vol_5m',
  '1h': 'close_vol_1h',
  '6h': 'close_vol_6h',
  '24h': 'close_vol_24h',
});

function coverageStateSql(window) {
  return `CASE jsonb_typeof(volume.window_coverage -> '${window}')
    WHEN 'object' THEN volume.window_coverage -> '${window}' ->> 'state'
    WHEN 'string' THEN volume.window_coverage ->> '${window}'
    ELSE NULL
  END`;
}

function coverageRankSql(window) {
  const column = VOLUME_COLUMNS[window];
  return `CASE
    WHEN volume.${column} IS NULL OR volume.bucket_ts IS NULL THEN 2
    WHEN volume.bucket_ts < $1::timestamptz - INTERVAL '1 minute' THEN 1
    WHEN (${coverageStateSql(window)}) = 'complete' THEN 0
    ELSE 1
  END`;
}

function buildOrderSql(sorts) {
  const clauses = [];
  for (const sort of sorts) {
    if (sort.mode === 'vol') {
      clauses.push(`${coverageRankSql(sort.window)} ASC`);
      clauses.push(`volume.${VOLUME_COLUMNS[sort.window]} DESC NULLS LAST`);
    } else if (sort.mode === 'mcap') {
      const direction = sort.window === 'lowest' ? 'ASC' : 'DESC';
      clauses.push(`tc.last_mcap ${direction} NULLS LAST`);
    } else {
      const direction = sort.window === 'oldest' ? 'ASC' : 'DESC';
      clauses.push(`${AGE_SQL} ${direction} NULLS LAST`);
    }
  }
  clauses.push(`${AGE_SQL} DESC NULLS LAST`);
  clauses.push('tc.last_mcap DESC NULLS LAST');
  clauses.push('tc.address COLLATE "C" ASC');
  return clauses.join(',\n  ');
}

function buildPrefixSql(sorts) {
  return `SELECT
  tc.address, tc.symbol, tc.name, tc.source,
  tc.first_seen_at, tc.last_evaluated_at, tc.last_mcap,
  tc.last_token_created_at_ms, tc.last_price, tc.last_liquidity_usd,
  tc.last_pair_address, tc.last_pair_url, tc.last_dex_id,
  tc.last_image_url, tc.last_twitter_url, tc.last_community_url,
  tc.monitor_priority, tc.last_seen_at, COUNT(*) OVER() AS total_count
FROM token_catalog tc
LEFT JOIN LATERAL (
  SELECT bucket_ts, close_vol_5m, close_vol_1h,
    close_vol_6h, close_vol_24h, window_coverage
  FROM token_market_volume_buckets_1m bucket
  WHERE bucket.chain = 'solana'
    AND bucket.token_address = tc.address
    AND bucket.bucket_ts < $1::timestamptz
  ORDER BY bucket.bucket_ts DESC
  LIMIT 1
) volume ON TRUE
WHERE tc.chain = 'solana'
  AND ((tc.last_mcap IS NULL AND $2::numeric = 0)
    OR (tc.last_mcap >= $2::numeric
      AND ($3::numeric IS NULL OR tc.last_mcap <= $3::numeric)))
  AND tc.address <> ALL($4::varchar[])
  AND NOT EXISTS (
    SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'solana' AND blocked.address = tc.address
  )
  AND NOT EXISTS (
    SELECT 1 FROM token_risk_reviews review
    WHERE review.chain = 'solana' AND review.token_address = tc.address
      AND LOWER(review.source) = 'manual' AND LOWER(review.label) = 'junk_permanent'
  )
ORDER BY ${buildOrderSql(sorts)}
LIMIT $5::int`;
}

const PINNED_SQL = `SELECT
  tc.address, tc.symbol, tc.name, tc.source,
  tc.first_seen_at, tc.last_evaluated_at, tc.last_mcap,
  tc.last_token_created_at_ms, tc.last_price, tc.last_liquidity_usd,
  tc.last_pair_address, tc.last_pair_url, tc.last_dex_id,
  tc.last_image_url, tc.last_twitter_url, tc.last_community_url,
  tc.monitor_priority, tc.last_seen_at
FROM token_catalog tc
WHERE tc.chain = 'solana'
  AND tc.address = ANY($1::varchar[])
  AND NOT EXISTS (
    SELECT 1 FROM admin_blocked_tokens blocked
    WHERE blocked.chain = 'solana' AND blocked.address = tc.address
  )
  AND NOT EXISTS (
    SELECT 1 FROM token_risk_reviews review
    WHERE review.chain = 'solana' AND review.token_address = tc.address
      AND LOWER(review.source) = 'manual' AND LOWER(review.label) = 'junk_permanent'
  )
ORDER BY array_position($1::varchar[], tc.address)`;

function normalizeMcap(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new RangeError(`${label} is invalid`);
  return parsed;
}

function normalizeFilters(input) {
  const minMcap = normalizeMcap(input.minMcap, DEFAULT_MIN_MCAP, 'minMcap');
  const rawMax = normalizeMcap(input.maxMcap, null, 'maxMcap');
  const maxMcap = rawMax === 0 ? null : rawMax;
  if (maxMcap != null && maxMcap < minMcap) {
    throw new RangeError('maxMcap must be greater than or equal to minMcap');
  }
  return Object.freeze({ minMcap, maxMcap });
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
  if (Number.isFinite(native) && native > 0) {
    return { value: native, provenance: 'chain-native' };
  }
  const firstSeenAt = optionalIso(row.first_seen_at, 'firstSeenAt');
  return {
    value: firstSeenAt == null ? null : new Date(firstSeenAt).getTime(),
    provenance: firstSeenAt == null ? 'unknown' : 'first-seen',
  };
}

function normalizeCatalogRow(row, metrics, query, filters) {
  const identity = createTokenIdentity(CHAIN, row.address);
  const valuationObservedAt = optionalIso(row.last_evaluated_at, 'valuation observedAt');
  const visibility = evaluateWorkspaceVisibility({
    identity,
    state: { lastActivityAt: metrics.lastActivityAt },
    valuation: { type: 'mcap', usd: row.last_mcap, observedAt: valuationObservedAt },
    filters: { minValuationUsd: filters.minMcap, maxValuationUsd: filters.maxMcap },
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
    lastEvaluatedAt: valuationObservedAt,
    tokenCreatedAt: age.value,
    tokenAgeProvenance: age.provenance,
    priceUsd: optionalNumber(row.last_price, 'priceUsd'),
    liquidityUsd: optionalNumber(row.last_liquidity_usd, 'liquidityUsd'),
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
  if (totals.size !== 1 || !Number.isSafeInteger([...totals][0]) || [...totals][0] < 0) {
    throw new Error('Solana monitored total is inconsistent');
  }
  const total = [...totals][0];
  const required = Math.min(total, requiredPrefix);
  if (rows.length !== required) {
    throw new Error(`Solana prefix returned ${rows.length} rows; ${required} required`);
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
    throw new Error(`Solana metric hydration returned ${hydrated.length} rows; ${rows.length} required`);
  }
  const byIdentity = new Map(hydrated.map((row) => [
    createTokenIdentity(row.chain, row.address).key, row,
  ]));
  return rows.map((row) => {
    const metrics = byIdentity.get(createTokenIdentity(CHAIN, row.address).key);
    if (!metrics) throw new Error(`Solana metrics missing for ${row.address}`);
    return metrics;
  });
}

function createSolanaWorkspaceTokenReader(options = {}) {
  const database = options.database || db;
  const windowRead = options.windowRead || createSolanaWorkspaceWindowReadRepository({ database });

  async function listMonitoredPrefix(input = {}) {
    const query = normalizeMonitoredQuery(input);
    const filters = normalizeFilters(input);
    const excludedAddresses = normalizeExcludedAddresses(input.excludedAddresses);
    const timeoutMs = normalizeTimeout(input.statementTimeoutMs);
    const sql = buildPrefixSql(query.sorts);
    const params = [new Date(query.asOf), filters.minMcap, filters.maxMcap,
      excludedAddresses, query.requiredPrefix];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(sql, params, timeoutMs)
      : await database.query(sql, params);
    const excluded = new Set(excludedAddresses);
    if (result.rows.some((row) => excluded.has(normalizeTokenAddress(CHAIN, row.address)))) {
      throw new Error('Solana SQL prefix contains a user-excluded identity');
    }
    const total = validateCandidateCount(result.rows, query.requiredPrefix);
    const metrics = await hydrateMetrics(result.rows, query, windowRead, timeoutMs);
    const rows = result.rows.map((row, index) => (
      normalizeCatalogRow(row, metrics[index], query, filters)
    ));
    for (let index = 1; index < rows.length; index += 1) {
      if (compareNormalizedMonitoredRows(rows[index - 1], rows[index], query.sorts) > 0) {
        throw new Error('Solana SQL prefix is not normalized-sort compatible');
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
    const params = [addresses];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(PINNED_SQL, params, timeoutMs)
      : await database.query(PINNED_SQL, params);
    const requested = new Set(addresses);
    const returned = new Set();
    for (const row of result.rows) {
      const address = normalizeTokenAddress(CHAIN, row.address);
      if (!requested.has(address) || returned.has(address)) {
        throw new Error('Solana pinned query returned an invalid identity set');
      }
      returned.add(address);
    }
    const metrics = await hydrateMetrics(result.rows, query, windowRead, timeoutMs);
    return Object.freeze(result.rows.map((row, index) => normalizeCatalogRow(
      row, metrics[index], query, { minMcap: 0, maxMcap: null },
    )));
  }

  return Object.freeze({ getTokensByAddresses, listMonitoredPrefix });
}

module.exports = {
  createSolanaWorkspaceTokenReader,
  __private: {
    PINNED_SQL, buildOrderSql, buildPrefixSql, normalizeCatalogRow,
    normalizeExcludedAddresses, normalizeFilters,
  },
};
