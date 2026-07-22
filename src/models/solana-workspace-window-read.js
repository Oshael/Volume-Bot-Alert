const db = require('./db');
const {
  VOLUME_WINDOWS,
  buildCanonicalVolumeJoinSql,
} = require('./solana-volume-window-sql');
const { createTokenIdentity, normalizeTokenAddress } = require('../utils/token-identity');
const {
  PRICE_CHANGE_WINDOWS,
  WINDOWS,
  buildNormalizedWindowMetrics,
  calculatePriceChange,
  normalizeAsOf,
  resolveBaselineCoverage,
  resolveSnapshotCoverage,
} = require('../services/workspace-window-metrics');

const CHAIN = 'solana';
const MAX_ADDRESSES = 100;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const COVERAGE_STATES = new Set(['complete', 'partial', 'unavailable']);

const WINDOW_METRICS_SQL = `WITH bounds AS (
  SELECT $2::timestamptz AS window_end
),
requested AS MATERIALIZED (
  SELECT UNNEST($1::varchar[]) AS token_address
)
SELECT requested.token_address,
  ${VOLUME_WINDOWS.map((window) => `volume.bucket_ts_${window} AS volume_${window}_observed_at,
  volume.coverage_state_${window} AS volume_${window}_coverage_state,
  volume.coverage_source_${window} AS volume_${window}_coverage_source,
  volume.close_vol_${window}`).join(',\n  ')},
  prices.current_price, prices.current_observed_at,
  prices.price_1h, prices.price_1h_observed_at,
  prices.price_6h, prices.price_6h_observed_at,
  prices.price_24h, prices.price_24h_observed_at
FROM requested
CROSS JOIN bounds
${buildCanonicalVolumeJoinSql({
    tokenAddressSql: 'requested.token_address', asOfSql: 'bounds.window_end',
  })}
LEFT JOIN LATERAL (
  SELECT
    (array_agg(bucket.close_price ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '15 minutes'))[1]
      AS current_price,
    (array_agg(bucket.bucket_ts ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts >= bounds.window_end - INTERVAL '15 minutes'))[1]
      AS current_observed_at,
    (array_agg(bucket.close_price ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= bounds.window_end - INTERVAL '1 hour'
        AND bucket.bucket_ts >= bounds.window_end - INTERVAL '1 hour 15 minutes'))[1]
      AS price_1h,
    (array_agg(bucket.bucket_ts ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= bounds.window_end - INTERVAL '1 hour'
        AND bucket.bucket_ts >= bounds.window_end - INTERVAL '1 hour 15 minutes'))[1]
      AS price_1h_observed_at,
    (array_agg(bucket.close_price ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= bounds.window_end - INTERVAL '6 hours'
        AND bucket.bucket_ts >= bounds.window_end - INTERVAL '6 hours 15 minutes'))[1]
      AS price_6h,
    (array_agg(bucket.bucket_ts ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= bounds.window_end - INTERVAL '6 hours'
        AND bucket.bucket_ts >= bounds.window_end - INTERVAL '6 hours 15 minutes'))[1]
      AS price_6h_observed_at,
    (array_agg(bucket.close_price ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= bounds.window_end - INTERVAL '24 hours'
        AND bucket.bucket_ts >= bounds.window_end - INTERVAL '24 hours 15 minutes'))[1]
      AS price_24h,
    (array_agg(bucket.bucket_ts ORDER BY bucket.bucket_ts DESC)
      FILTER (WHERE bucket.bucket_ts <= bounds.window_end - INTERVAL '24 hours'
        AND bucket.bucket_ts >= bounds.window_end - INTERVAL '24 hours 15 minutes'))[1]
      AS price_24h_observed_at
  FROM token_market_buckets_1m bucket
  WHERE bucket.chain = 'solana'
    AND bucket.token_address = requested.token_address
    AND bucket.bucket_ts >= bounds.window_end - INTERVAL '24 hours 15 minutes'
    AND bucket.bucket_ts < bounds.window_end
    AND bucket.close_price IS NOT NULL
) prices ON TRUE
ORDER BY requested.token_address ASC`;

function normalizeAddresses(values) {
  const addresses = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeTokenAddress(CHAIN, value)))];
  if (addresses.length > MAX_ADDRESSES) {
    throw new Error(`Solana workspace metrics accept at most ${MAX_ADDRESSES} addresses`);
  }
  return addresses;
}

function normalizeTimeout(value) {
  const parsed = Number(value ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 60_000) {
    throw new Error('Solana workspace metric timeout must be between 1000 and 60000');
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

function normalizeDeclaredCoverage(value) {
  const input = value && typeof value === 'object' ? value : {};
  const states = {};
  const sources = {};
  for (const window of WINDOWS) {
    const entry = input[window];
    if (entry == null) continue;
    const structured = typeof entry === 'object' && !Array.isArray(entry);
    const candidateState = String(structured ? entry.state : entry).trim().toLowerCase();
    states[window] = COVERAGE_STATES.has(candidateState) ? candidateState : 'partial';
    const candidateSource = structured ? String(entry.source || '').trim().toLowerCase() : '';
    sources[window] = candidateSource || null;
  }
  return { states, sources };
}

function resolveDeclaredCoverage(row) {
  const explicit = {};
  for (const window of WINDOWS) {
    const state = row[`volume_${window}_coverage_state`];
    const source = row[`volume_${window}_coverage_source`];
    if (state != null) explicit[window] = { state, source };
  }
  return normalizeDeclaredCoverage(Object.keys(explicit).length ? explicit : row.window_coverage);
}

function resolveCommonSource(declared) {
  const windows = Object.keys(declared.states);
  if (!windows.length) return null;
  const sources = windows.map((window) => declared.sources[window]);
  if (sources.some((source) => !source)) return null;
  const unique = new Set(sources);
  return unique.size === 1 ? sources[0] : null;
}

function volumeObservedAtField(row, window) {
  const field = `volume_${window}_observed_at`;
  return Object.prototype.hasOwnProperty.call(row, field) ? field : 'volume_observed_at';
}

function resolveVolumeCoverage(row, window, windowEnd, declared) {
  const coverage = resolveSnapshotCoverage({
    window,
    windowEnd,
    value: row[`close_vol_${window}`],
    observedAt: row[volumeObservedAtField(row, window)],
  });
  if (coverage !== 'complete') return coverage;
  return declared.states[window] === 'complete' ? 'complete' : 'partial';
}

function normalizeRow(row, windowEnd) {
  const declared = resolveDeclaredCoverage(row);
  const coverage = Object.fromEntries(WINDOWS.map((window) => [
    window, resolveVolumeCoverage(row, window, windowEnd, declared),
  ]));
  const currentObservedAt = rowTimestamp(row, 'current_observed_at');
  const priceChanges = {};
  const priceChangeCoverage = {};
  for (const window of PRICE_CHANGE_WINDOWS) {
    const baselineAt = rowTimestamp(row, `price_${window}_observed_at`);
    priceChangeCoverage[window] = resolveBaselineCoverage({
      window, windowEnd, currentObservedAt, baselineObservedAt: baselineAt,
    });
    priceChanges[window] = calculatePriceChange(
      row.current_price, row[`price_${window}`],
    );
  }
  const volumeObservedAtByWindow = Object.fromEntries(WINDOWS.map((window) => [
    window,
    rowTimestamp(row, volumeObservedAtField(row, window)),
  ]));
  const volumeObservedAt = Object.values(volumeObservedAtByWindow)
    .filter(Boolean).sort().at(-1) || null;
  const metrics = buildNormalizedWindowMetrics({
    windowEnd,
    lastActivityAt: null,
    volumes: Object.fromEntries(WINDOWS.map((window) => [
      window, row[`close_vol_${window}`],
    ])),
    coverage,
    priceChanges,
    priceChangeCoverage,
  });
  return Object.freeze({
    ...createTokenIdentity(CHAIN, row.token_address),
    ...metrics,
    coverageProvenance: Object.freeze({
      source: 'solana-rolling-volume-snapshot',
      upstreamSource: resolveCommonSource(declared),
      observedAt: volumeObservedAt,
      observedAtByWindow: Object.freeze(volumeObservedAtByWindow),
      historyStartAt: null,
      exactLastActivity: false,
      declaredCoverage: Object.freeze(declared.states),
      declaredSources: Object.freeze(declared.sources),
    }),
  });
}

function createSolanaWorkspaceWindowReadRepository(options = {}) {
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
  createSolanaWorkspaceWindowReadRepository,
  __private: {
    WINDOW_METRICS_SQL,
    normalizeAddresses,
    normalizeDeclaredCoverage,
    normalizeRow,
    resolveVolumeCoverage,
  },
};
