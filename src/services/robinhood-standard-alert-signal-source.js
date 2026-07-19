const db = require('../models/db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { calculatePriceChange } = require('./workspace-window-metrics');

const CHAIN = 'robinhood';
const HOUR_MS = 60 * 60 * 1000;
const MAX_QUERY_TOKENS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const BASELINE_TOLERANCE_MS = 15 * 60 * 1000;
const WINDOWS = Object.freeze(['1h', '6h']);
const WINDOW_MS = Object.freeze({ '1h': HOUR_MS, '6h': 6 * HOUR_MS });
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);

const BASELINE_SQL = `WITH input AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    token_address text, protocol text, market_key text
  )
),
market_cursor AS (
  SELECT coverage_start_timestamp AS coverage_start_at,
    checkpoint_timestamp AS coverage_end_at,
    next_block > safe_head AS caught_up
  FROM robinhood_ingestion_cursors
  WHERE chain = 'robinhood' AND stream = 'market'
),
token_context AS (
  SELECT input.token_address, input.protocol, input.market_key,
    COALESCE(
      TO_TIMESTAMP(NULLIF(catalog.last_token_created_at_ms, 0) / 1000.0),
      MIN(registry.discovered_at)
    ) AS token_created_at,
    CASE WHEN catalog.last_token_created_at_ms > 0
      THEN 'token-catalog' ELSE 'pool-registry-discovery' END AS token_age_source,
    EXISTS (
      SELECT 1 FROM admin_blocked_tokens blocked
      WHERE blocked.chain = 'robinhood' AND blocked.address = input.token_address
    ) AS admin_blocked
  FROM input
  LEFT JOIN token_catalog catalog
    ON catalog.chain = 'robinhood' AND catalog.address = input.token_address
  LEFT JOIN robinhood_pool_registry registry
    ON registry.chain = 'robinhood'
   AND registry.token_address = input.token_address
   AND registry.active = true
  GROUP BY input.token_address, input.protocol, input.market_key,
    catalog.last_token_created_at_ms
),
specs(window_name, target_at) AS (
  VALUES ('1h', $2::timestamptz - INTERVAL '1 hour'),
    ('6h', $2::timestamptz - INTERVAL '6 hours')
),
points AS (
  SELECT context.token_address, specs.window_name,
    point.close_price_usd, point.close_fdv_usd, point.last_observed_at
  FROM token_context context CROSS JOIN specs
  LEFT JOIN LATERAL (
    SELECT bucket.close_price_usd, bucket.close_fdv_usd, bucket.last_observed_at
    FROM robinhood_market_buckets_1m bucket
    WHERE bucket.chain = 'robinhood'
      AND bucket.protocol = context.protocol
      AND bucket.market_key = context.market_key
      AND bucket.bucket_ts >= specs.target_at - INTERVAL '15 minutes'
      AND bucket.bucket_ts <= specs.target_at
      AND bucket.last_observed_at <= specs.target_at
    ORDER BY bucket.last_block_number DESC, bucket.last_log_index DESC
    LIMIT 1
  ) point ON TRUE
)
SELECT context.*,
  cursor.coverage_start_at, cursor.coverage_end_at, cursor.caught_up,
  MAX(points.close_price_usd) FILTER (WHERE window_name = '1h') AS price_1h_usd,
  MAX(points.close_fdv_usd) FILTER (WHERE window_name = '1h') AS fdv_1h_usd,
  MAX(points.last_observed_at) FILTER (WHERE window_name = '1h') AS observed_1h_at,
  MAX(points.close_price_usd) FILTER (WHERE window_name = '6h') AS price_6h_usd,
  MAX(points.close_fdv_usd) FILTER (WHERE window_name = '6h') AS fdv_6h_usd,
  MAX(points.last_observed_at) FILTER (WHERE window_name = '6h') AS observed_6h_at
FROM token_context context
LEFT JOIN points USING (token_address)
LEFT JOIN market_cursor cursor ON TRUE
GROUP BY context.token_address, context.protocol, context.market_key,
  context.token_created_at, context.token_age_source, context.admin_blocked,
  cursor.coverage_start_at, cursor.coverage_end_at, cursor.caught_up
ORDER BY context.token_address`;

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestamp(value) {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function exactContinuousCoverage(window, asOf, startValue, endValue) {
  const start = timestamp(startValue);
  const end = timestamp(endValue);
  if (!start || !end || new Date(end) <= new Date(start)) return 'unavailable';
  const windowStartMs = asOf.getTime() - WINDOW_MS[window];
  if (new Date(end).getTime() <= windowStartMs || new Date(start).getTime() >= asOf.getTime()) {
    return 'unavailable';
  }
  return new Date(start).getTime() <= windowStartMs && new Date(end).getTime() >= asOf.getTime()
    ? 'complete' : 'partial';
}

function exactBaselineCoverage(window, asOf, currentValue, baselineValue) {
  const currentAt = timestamp(currentValue);
  const baselineAt = timestamp(baselineValue);
  if (!currentAt || !baselineAt) return 'unavailable';
  const currentAge = asOf.getTime() - new Date(currentAt).getTime();
  const baselineAge = asOf.getTime() - WINDOW_MS[window] - new Date(baselineAt).getTime();
  if (currentAge < 0 || baselineAge < 0) return 'unavailable';
  return currentAge <= BASELINE_TOLERANCE_MS && baselineAge <= BASELINE_TOLERANCE_MS
    ? 'complete' : 'partial';
}

function latestBuckets(rows) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const address = normalizeTokenAddress(CHAIN, row.tokenAddress);
    const existing = latest.get(address);
    const ordering = [BigInt(row.lastBlockNumber), BigInt(row.lastLogIndex)];
    const previous = existing?.ordering;
    if (!previous || ordering[0] > previous[0]
      || (ordering[0] === previous[0] && ordering[1] > previous[1])) {
      latest.set(address, { row, ordering });
    }
  }
  return [...latest.values()].map((entry) => entry.row);
}

function ageFacts(createdAtValue, asOf, source) {
  const createdAt = timestamp(createdAtValue);
  const rawAgeMs = createdAt ? asOf.getTime() - new Date(createdAt).getTime() : null;
  const ageMs = rawAgeMs != null && rawAgeMs >= 0 ? rawAgeMs : null;
  let bucket = 'unknown';
  if (ageMs != null) {
    if (ageMs < HOUR_MS) bucket = 'under-1h';
    else if (ageMs < 24 * HOUR_MS) bucket = '1h-to-24h';
    else if (ageMs < 48 * HOUR_MS) bucket = '1d-to-2d';
    else if (ageMs < 7 * 24 * HOUR_MS) bucket = '2d-to-7d';
    else bucket = '7d-plus';
  }
  return Object.freeze({
    createdAt, ageMs, bucket, source: createdAt ? source : 'unavailable',
    eligibility: Object.freeze({
      minimum1h: ageMs == null || ageMs >= HOUR_MS,
      recentSurge1h: ageMs != null && ageMs >= 24 * HOUR_MS && ageMs < 7 * 24 * HOUR_MS,
      recentSurge6h: ageMs != null && ageMs >= 48 * HOUR_MS && ageMs < 7 * 24 * HOUR_MS,
      oldWeekSurge: ageMs != null && ageMs >= 7 * 24 * HOUR_MS,
    }),
  });
}

function valuationWindow(row, current, window, asOf, cursorCoverage) {
  const baselineAt = timestamp(row[`observed_${window}_at`]);
  const baselineCoverage = exactBaselineCoverage(
    window, asOf, current.observedAt, baselineAt
  );
  const coverage = cursorCoverage === 'unavailable' || baselineCoverage === 'unavailable'
    ? 'unavailable'
    : (cursorCoverage === 'partial' || baselineCoverage === 'partial' ? 'partial' : 'complete');
  const priceUsd = numberOrNull(row[`price_${window}_usd`]);
  const fdvUsd = numberOrNull(row[`fdv_${window}_usd`]);
  return Object.freeze({
    baselineAt, priceUsd, fdvUsd, coverage,
    priceChangePct: coverage === 'complete'
      ? calculatePriceChange(current.priceUsd, priceUsd) : null,
    fdvChangePct: coverage === 'complete'
      ? calculatePriceChange(current.fdvUsd, fdvUsd) : null,
  });
}

function buildSignal(bucket, context, cursor, asOf) {
  const current = Object.freeze({
    protocol: String(bucket.valuationProtocol),
    marketKey: String(bucket.valuationMarketKey),
    observedAt: timestamp(bucket.lastObservedAt),
    priceUsd: numberOrNull(bucket.closePriceUsd),
    fdvUsd: numberOrNull(bucket.closeFdvUsd),
  });
  const coverage = Object.fromEntries(WINDOWS.map((window) => [window,
    exactContinuousCoverage(
      window, asOf, context.coverage_start_at, context.coverage_end_at
    )]));
  const volumeCoverage = String(bucket.volume5mDeltaCoverage || 'unavailable');
  const volumeCurrent = numberOrNull(bucket.currentVolume5mUsd);
  const volumeBaseline = numberOrNull(bucket.prevVolume5mCanonical);
  return Object.freeze({
    id: `${CHAIN}:${normalizeTokenAddress(CHAIN, bucket.tokenAddress)}:${cursor.nextBlock}`,
    chain: CHAIN,
    address: normalizeTokenAddress(CHAIN, bucket.tokenAddress),
    source: 'robinhood-committed-swaps',
    generatedAt: asOf.toISOString(),
    volume5m: Object.freeze({
      currentUsd: volumeCurrent, baselineUsd: volumeBaseline,
      changePct: volumeCoverage === 'complete'
        ? calculatePriceChange(volumeCurrent, volumeBaseline) : null,
      baselineAt: timestamp(bucket.volume5mBaselineAt),
      windowEnd: timestamp(bucket.volume5mWindowEnd), coverage: volumeCoverage,
    }),
    valuation: Object.freeze({
      type: 'fdv', source: 'robinhood-accepted-swaps', current,
      windows: Object.freeze(Object.fromEntries(WINDOWS.map((window) => [window,
        valuationWindow(context, current, window, asOf, coverage[window])]))),
    }),
    tokenAge: ageFacts(context.token_created_at, asOf, context.token_age_source),
    filters: Object.freeze({ adminBlocked: context.admin_blocked === true }),
    coverageProvenance: Object.freeze({
      source: 'robinhood-market-cursor',
      startAt: timestamp(context.coverage_start_at),
      endAt: timestamp(context.coverage_end_at),
      caughtUp: context.caught_up === true,
    }),
  });
}

function createRobinhoodStandardAlertSignalSource(options = {}) {
  const database = options.database || db;
  const timeoutMs = Number(options.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    throw new Error('Robinhood standard signal timeout must be between 1000 and 60000');
  }
  async function buildFromCommittedBuckets(input = {}) {
    const cursor = input.cursor || {};
    const asOf = new Date(cursor.checkpointTimestamp);
    if (!Number.isFinite(asOf.getTime()) || !/^\d+$/.test(String(cursor.nextBlock || ''))) {
      throw new Error('Robinhood committed signal cursor is invalid');
    }
    const buckets = latestBuckets(input.buckets);
    const signals = [];
    for (let offset = 0; offset < buckets.length; offset += MAX_QUERY_TOKENS) {
      const chunk = buckets.slice(offset, offset + MAX_QUERY_TOKENS);
      const targets = chunk.map((row) => {
        const protocol = String(row.valuationProtocol || '');
        const marketKey = String(row.valuationMarketKey || '').toLowerCase();
        if (!PROTOCOLS.has(protocol) || !marketKey.startsWith(`${CHAIN}:${protocol}:`)) {
          throw new Error('Robinhood committed signal market identity is invalid');
        }
        return {
          token_address: normalizeTokenAddress(CHAIN, row.tokenAddress),
          protocol, market_key: marketKey,
        };
      });
      const execute = typeof database.queryWithStatementTimeout === 'function'
        ? database.queryWithStatementTimeout.bind(database)
        : database.query.bind(database);
      const result = await execute(BASELINE_SQL, [JSON.stringify(targets), asOf], timeoutMs);
      const contexts = new Map(result.rows.map((row) => [row.token_address, row]));
      for (const bucket of chunk) {
        const address = normalizeTokenAddress(CHAIN, bucket.tokenAddress);
        const context = contexts.get(address);
        if (context) signals.push(buildSignal(bucket, context, cursor, asOf));
      }
    }
    return Object.freeze(signals);
  }
  return Object.freeze({ buildFromCommittedBuckets });
}

module.exports = {
  createRobinhoodStandardAlertSignalSource,
  __private: {
    BASELINE_SQL, ageFacts, buildSignal, exactBaselineCoverage,
    exactContinuousCoverage, latestBuckets, valuationWindow,
  },
};
