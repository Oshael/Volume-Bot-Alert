const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES,
  MAX_EXPANDED_SPARKLINE_POINTS,
  isRobinhoodFullHistoryGranularityMinutes,
} = require('../utils/market-bucket-granularities');

const CHAIN = 'robinhood';
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MINUTE_RETENTION_MS = 14 * 24 * 60 * MINUTE_MS;
const MAX_WINDOW_MS = 10 * 365 * 24 * 60 * MINUTE_MS;
const MAX_CANDLES = MAX_EXPANDED_SPARKLINE_POINTS;
const MAX_ADDRESSES = 100;
const DEFAULT_CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 250;
const GRANULARITIES = new Set([1, 5, 15, 30, 60, 240, 1440]);
const SOURCE_COLUMNS = `bucket.token_address, bucket.protocol, bucket.market_key, bucket.bucket_ts,
  bucket.open_price_usd, bucket.high_price_usd, bucket.low_price_usd,
  bucket.close_price_usd, bucket.open_fdv_usd, bucket.high_fdv_usd,
  bucket.low_fdv_usd, bucket.close_fdv_usd, bucket.volume_usd,
  bucket.swaps, bucket.buys, bucket.sells, bucket.transactions,
  bucket.first_block_number, bucket.first_log_index,
  bucket.last_block_number, bucket.last_log_index`;

const AGGREGATE_HISTORY_SQL = `WITH requested AS MATERIALIZED (
  SELECT UNNEST($1::varchar[]) AS token_address
), ranked AS (
  SELECT bucket.token_address, bucket.bucket_ts, bucket.granularity_minutes,
    bucket.source_granularity_minutes,
    bucket.open_fdv_usd, bucket.high_fdv_usd, bucket.low_fdv_usd,
    bucket.close_fdv_usd, bucket.open_price_usd, bucket.high_price_usd,
    bucket.low_price_usd, bucket.close_price_usd, bucket.volume_usd,
    bucket.swaps, bucket.buys, bucket.sells,
    bucket.transactions AS transaction_contributions,
    bucket.market_count, bucket.protocols,
    ROW_NUMBER() OVER (
      PARTITION BY bucket.token_address ORDER BY bucket.bucket_ts DESC
    ) AS recency_rank
  FROM robinhood_market_buckets_agg bucket
  INNER JOIN requested ON requested.token_address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.granularity_minutes = $4::int
    AND bucket.bucket_ts >= date_bin(
      $4::int * INTERVAL '1 minute', $2::timestamptz, TIMESTAMPTZ '1970-01-01')
    AND bucket.bucket_ts < $3::timestamptz
)
SELECT * FROM ranked
WHERE recency_rank <= $5::int
ORDER BY token_address ASC, bucket_ts ASC`;

const LEGACY_HISTORY_SQL = `WITH requested AS MATERIALIZED (
  SELECT UNNEST($1::varchar[]) AS token_address
), source_rows AS (
  SELECT ${SOURCE_COLUMNS}, 60 AS source_granularity_minutes
  FROM robinhood_market_buckets_1h bucket
  INNER JOIN requested ON requested.token_address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts >= date_trunc('hour', $2::timestamptz)
    AND bucket.bucket_ts < $3::timestamptz
    AND ($4::int >= 60 OR bucket.bucket_ts < $5::timestamptz)
    AND ($7::timestamptz IS NULL OR bucket.bucket_ts < $7 OR bucket.bucket_ts >= $8)
  UNION ALL
  SELECT ${SOURCE_COLUMNS}, 1 AS source_granularity_minutes
  FROM robinhood_market_buckets_1m bucket
  INNER JOIN requested ON requested.token_address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND $4::int < 60
    AND bucket.bucket_ts >= $5::timestamptz
    AND bucket.bucket_ts >= date_bin(
      $4::int * INTERVAL '1 minute', $2::timestamptz, TIMESTAMPTZ '1970-01-01')
    AND bucket.bucket_ts < $3::timestamptz
    AND ($7::timestamptz IS NULL OR bucket.bucket_ts < $7 OR bucket.bucket_ts >= $8)
), normalized AS (
  SELECT source_rows.*,
    GREATEST($4::int, source_granularity_minutes) AS output_granularity_minutes,
    date_bin(
      GREATEST($4::int, source_granularity_minutes) * INTERVAL '1 minute',
      bucket_ts, TIMESTAMPTZ '1970-01-01'
    ) AS output_bucket_ts
  FROM source_rows
), candles AS (
  SELECT token_address, output_bucket_ts AS bucket_ts,
    output_granularity_minutes AS granularity_minutes,
    MIN(source_granularity_minutes) AS source_granularity_minutes,
    (array_agg(open_fdv_usd ORDER BY bucket_ts, first_block_number,
      first_log_index, protocol, market_key))[1] AS open_fdv_usd,
    MAX(high_fdv_usd) AS high_fdv_usd,
    MIN(low_fdv_usd) AS low_fdv_usd,
    (array_agg(close_fdv_usd ORDER BY bucket_ts DESC, last_block_number DESC,
      last_log_index DESC, protocol, market_key))[1] AS close_fdv_usd,
    (array_agg(open_price_usd ORDER BY bucket_ts, first_block_number,
      first_log_index, protocol, market_key))[1] AS open_price_usd,
    MAX(high_price_usd) AS high_price_usd,
    MIN(low_price_usd) AS low_price_usd,
    (array_agg(close_price_usd ORDER BY bucket_ts DESC, last_block_number DESC,
      last_log_index DESC, protocol, market_key))[1] AS close_price_usd,
    SUM(volume_usd) AS volume_usd,
    SUM(swaps)::bigint AS swaps, SUM(buys)::bigint AS buys,
    SUM(sells)::bigint AS sells,
    SUM(transactions)::bigint AS transaction_contributions,
    COUNT(DISTINCT (protocol, market_key))::int AS market_count,
    array_agg(DISTINCT protocol ORDER BY protocol) AS protocols
  FROM normalized
  GROUP BY token_address, output_bucket_ts, output_granularity_minutes
), ranked AS (
  SELECT candles.*,
    ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY bucket_ts DESC) AS recency_rank
  FROM candles
)
SELECT * FROM ranked
WHERE recency_rank <= $6::int
ORDER BY token_address ASC, bucket_ts ASC`;

const ALL_AVAILABLE_HISTORY_SQL = `WITH requested AS MATERIALIZED (
  SELECT UNNEST($1::varchar[]) AS token_address
), source_rows AS (
  SELECT ${SOURCE_COLUMNS}
  FROM robinhood_market_buckets_1h bucket
  INNER JOIN requested ON requested.token_address = bucket.token_address
  WHERE bucket.chain = 'robinhood'
    AND bucket.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
    AND bucket.bucket_ts < $2::timestamptz
), candles AS (
  SELECT token_address, bucket_ts,
    60 AS granularity_minutes, 60 AS source_granularity_minutes,
    (array_agg(open_fdv_usd ORDER BY first_block_number,
      first_log_index, protocol, market_key))[1] AS open_fdv_usd,
    MAX(high_fdv_usd) AS high_fdv_usd,
    MIN(low_fdv_usd) AS low_fdv_usd,
    (array_agg(close_fdv_usd ORDER BY last_block_number DESC,
      last_log_index DESC, protocol, market_key))[1] AS close_fdv_usd,
    (array_agg(open_price_usd ORDER BY first_block_number,
      first_log_index, protocol, market_key))[1] AS open_price_usd,
    MAX(high_price_usd) AS high_price_usd,
    MIN(low_price_usd) AS low_price_usd,
    (array_agg(close_price_usd ORDER BY last_block_number DESC,
      last_log_index DESC, protocol, market_key))[1] AS close_price_usd,
    SUM(volume_usd) AS volume_usd,
    SUM(swaps)::bigint AS swaps, SUM(buys)::bigint AS buys,
    SUM(sells)::bigint AS sells,
    SUM(transactions)::bigint AS transaction_contributions,
    COUNT(DISTINCT (protocol, market_key))::int AS market_count,
    array_agg(DISTINCT protocol ORDER BY protocol) AS protocols
  FROM source_rows
  GROUP BY token_address, bucket_ts
), ranked AS (
  SELECT candles.*,
    ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY bucket_ts ASC) AS row_number,
    COUNT(*) OVER (PARTITION BY token_address) AS total_count
  FROM candles
), counts AS (
  SELECT token_address, MAX(total_count) AS total_count
  FROM ranked
  GROUP BY token_address
), targets AS (
  SELECT counts.token_address,
    ROUND(
      1 + sample_index * (counts.total_count - 1)::numeric
        / GREATEST(LEAST(counts.total_count, $3::bigint) - 1, 1)
    )::bigint AS target_row
  FROM counts
  CROSS JOIN LATERAL generate_series(
    0, LEAST(counts.total_count, $3::bigint)::int - 1
  ) AS samples(sample_index)
)
SELECT ranked.*
FROM ranked
INNER JOIN targets
  ON targets.token_address = ranked.token_address
 AND targets.target_row = ranked.row_number
ORDER BY ranked.token_address ASC, ranked.bucket_ts ASC`;

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

function ceilHour(value) {
  const hourMs = 60 * MINUTE_MS;
  return new Date(Math.ceil(value.getTime() / hourMs) * hourMs);
}

function normalizeAddresses(input) {
  const values = Array.isArray(input.addresses) ? input.addresses : [input.address];
  const addresses = [...new Set(values.map((value) => normalizeTokenAddress(CHAIN, value)))];
  if (!addresses.length || addresses.length > MAX_ADDRESSES) {
    throw new Error(`Robinhood history accepts between 1 and ${MAX_ADDRESSES} addresses`);
  }
  return addresses;
}

function validateHistoryGranularity(granularityMinutes, allAvailable) {
  if (!GRANULARITIES.has(granularityMinutes)) {
    throw new Error('Robinhood history granularity must be one of 1, 5, 15, 30, 60, 240, 1440');
  }
  const allAvailableSupported = granularityMinutes === ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES
    || isRobinhoodFullHistoryGranularityMinutes(granularityMinutes);
  if (allAvailable && !allAvailableSupported) {
    throw new Error('Robinhood all-available history supports only 5, 15, 30, or 60 minutes');
  }
}

function normalizeQuery(input, now) {
  const addresses = normalizeAddresses(input);
  const endAt = timestamp(input.endAt, 'endAt');
  const allAvailable = input.allAvailable === true;
  const startAt = allAvailable
    ? new Date(endAt.getTime() - MAX_WINDOW_MS)
    : timestamp(input.startAt, 'startAt');
  const windowMs = endAt.getTime() - startAt.getTime();
  if (windowMs <= 0 || windowMs > MAX_WINDOW_MS) {
    throw new Error('Robinhood history window must be greater than zero and at most 10 years');
  }
  const granularityMinutes = Number(input.granularityMinutes
    ?? (allAvailable ? ALL_AVAILABLE_SPARKLINE_GRANULARITY_MINUTES : 5));
  validateHistoryGranularity(granularityMinutes, allAvailable);
  const limit = Number(input.limit ?? 1000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDLES) {
    throw new Error(`Robinhood history limit must be between 1 and ${MAX_CANDLES}`);
  }
  const statementTimeoutMs = Number(input.statementTimeoutMs ?? 15_000);
  if (!Number.isSafeInteger(statementTimeoutMs)
    || statementTimeoutMs < 1000 || statementTimeoutMs > 60_000) {
    throw new Error('Robinhood history timeout must be between 1000 and 60000');
  }
  return {
    addresses, startAt, endAt, granularityMinutes, limit, statementTimeoutMs,
    allAvailable,
    minuteStartsAt: ceilHour(new Date(now.getTime() - MINUTE_RETENTION_MS)),
    onMetrics: typeof input.onMetrics === 'function' ? input.onMetrics : null,
  };
}

function numberValue(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function countValue(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside safe range`);
  return parsed;
}

function normalizeCandle(row, address) {
  const bucketTs = timestamp(row.bucket_ts, 'bucket_ts').toISOString();
  const granularityMinutes = countValue(row.granularity_minutes, 'granularity_minutes');
  const sourceGranularityMinutes = countValue(
    row.source_granularity_minutes, 'source_granularity_minutes',
  );
  return Object.freeze({
    chain: CHAIN,
    address,
    bucketTs,
    granularityMinutes,
    sourceGranularityMinutes,
    valuationType: 'fdv',
    openFdvUsd: numberValue(row.open_fdv_usd, 'open_fdv_usd'),
    highFdvUsd: numberValue(row.high_fdv_usd, 'high_fdv_usd'),
    lowFdvUsd: numberValue(row.low_fdv_usd, 'low_fdv_usd'),
    closeFdvUsd: numberValue(row.close_fdv_usd, 'close_fdv_usd'),
    openPriceUsd: numberValue(row.open_price_usd, 'open_price_usd'),
    highPriceUsd: numberValue(row.high_price_usd, 'high_price_usd'),
    lowPriceUsd: numberValue(row.low_price_usd, 'low_price_usd'),
    closePriceUsd: numberValue(row.close_price_usd, 'close_price_usd'),
    activity: Object.freeze({
      volumeUsd: numberValue(row.volume_usd, 'volume_usd'),
      swaps: countValue(row.swaps, 'swaps'),
      buys: countValue(row.buys, 'buys'),
      sells: countValue(row.sells, 'sells'),
      transactionContributions: countValue(
        row.transaction_contributions, 'transaction_contributions',
      ),
      marketCount: countValue(row.market_count, 'market_count'),
      protocols: Object.freeze(Array.isArray(row.protocols) ? [...row.protocols] : []),
    }),
  });
}

function resolveResolution(candles) {
  const sources = new Set(candles.map((candle) => candle.sourceGranularityMinutes));
  if (!sources.size) return 'none';
  if (sources.size > 1) return 'mixed';
  return sources.has(1) ? 'minute' : 'hour';
}

function buildHistoryResult(query, address, rows) {
  const normalized = rows.map((row) => normalizeCandle(row, address));
  const truncated = normalized.length > query.limit;
  const candles = Object.freeze(normalized.slice(truncated ? -query.limit : 0));
  return Object.freeze({
    chain: CHAIN,
    address,
    requestedStartAt: query.startAt.toISOString(),
    requestedEndAt: query.endAt.toISOString(),
    requestedGranularityMinutes: query.granularityMinutes,
    minuteStartsAt: query.minuteStartsAt.toISOString(),
    resolution: resolveResolution(candles),
    truncated,
    firstBucketAt: candles[0]?.bucketTs || null,
    latestBucketAt: candles.at(-1)?.bucketTs || null,
    candles,
  });
}

function groupRows(query, rows) {
  const rowsByAddress = new Map(query.addresses.map((address) => [address, []]));
  for (const row of rows) {
    const address = normalizeTokenAddress(CHAIN, row.token_address);
    if (!rowsByAddress.has(address)) throw new Error('Robinhood history returned an unrequested token');
    rowsByAddress.get(address).push(row);
  }
  return rowsByAddress;
}

function normalizeVerifiedCoverage(input) {
  if (input?.from == null && input?.through == null) return null;
  if (input?.from == null || input?.through == null) {
    throw new Error('Robinhood verified aggregate coverage requires from and through');
  }
  const from = timestamp(input.from, 'verified aggregate coverage from');
  const through = timestamp(input.through, 'verified aggregate coverage through');
  if (from >= through) throw new Error('Robinhood verified aggregate coverage is empty');
  if (from.getTime() % DAY_MS || through.getTime() % DAY_MS) {
    throw new Error('Robinhood verified aggregate coverage must align to UTC days');
  }
  return Object.freeze({ from, through });
}

function intersectCoverage(query, coverage) {
  if (!coverage) return null;
  const from = new Date(Math.max(query.startAt.getTime(), coverage.from.getTime()));
  const through = new Date(Math.min(query.endAt.getTime(), coverage.through.getTime()));
  return from < through ? Object.freeze({ from, through }) : null;
}

function coversQuery(query, coverage) {
  return coverage?.from <= query.startAt && coverage?.through >= query.endAt;
}

function mergeRows(aggregateRows, fallbackRows) {
  const byBucket = new Map();
  for (const row of fallbackRows) byBucket.set(`${row.token_address}:${row.bucket_ts}`, row);
  for (const row of aggregateRows) byBucket.set(`${row.token_address}:${row.bucket_ts}`, row);
  return [...byBucket.values()].sort((left, right) => (
    new Date(left.bucket_ts) - new Date(right.bucket_ts)
  ));
}

function candleSignature(row) {
  const ignored = new Set(['recency_rank', 'row_number', 'total_count']);
  return JSON.stringify(Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !ignored.has(key))
      .map(([key, value]) => [key, key === 'protocols' ? [...value].sort() : String(value)])
  ));
}

function compareShadowRows(aggregateRows, legacyRows) {
  const key = (row) => `${row.token_address}:${new Date(row.bucket_ts).toISOString()}`;
  const aggregate = new Map(aggregateRows.map((row) => [key(row), candleSignature(row)]));
  const legacy = new Map(legacyRows.map((row) => [key(row), candleSignature(row)]));
  const keys = new Set([...aggregate.keys(), ...legacy.keys()]);
  let missingAggregateRows = 0;
  let missingLegacyRows = 0;
  let divergentRows = 0;
  for (const bucket of keys) {
    if (!aggregate.has(bucket)) missingAggregateRows += 1;
    else if (!legacy.has(bucket)) missingLegacyRows += 1;
    else if (aggregate.get(bucket) !== legacy.get(bucket)) divergentRows += 1;
  }
  return {
    comparedRows: keys.size, missingAggregateRows, missingLegacyRows, divergentRows,
  };
}

function buildCacheKey(query, cacheTtlMs, rollout) {
  return JSON.stringify([
    query.addresses,
    Math.floor(query.startAt.getTime() / cacheTtlMs),
    Math.floor(query.endAt.getTime() / cacheTtlMs),
    query.granularityMinutes,
    query.limit,
    query.allAvailable,
    rollout.aggregateReadsEnabled,
    rollout.fallbackEnabled,
    rollout.shadowCompareEnabled,
    rollout.verifiedCoverage?.from.toISOString() || null,
    rollout.verifiedCoverage?.through.toISOString() || null,
  ]);
}

function resolveReadCoverage(query, rollout) {
  if (!rollout.aggregateReadsEnabled || query.granularityMinutes === 1) return null;
  const coverage = intersectCoverage(query, rollout.verifiedCoverage);
  if (coverage && !rollout.fallbackEnabled && !coversQuery(query, coverage)) return null;
  return coverage;
}

async function readShadowComparison(query, execute, coverage, aggregateRows, enabled) {
  if (!enabled || !coverage) return { value: null, durationMs: 0 };
  const from = query.granularityMinutes < 60
    ? new Date(Math.max(coverage.from, query.minuteStartsAt))
    : coverage.from;
  if (from >= coverage.through) return { value: null, durationMs: 0 };
  const startedAt = Date.now();
  const legacy = await execute(LEGACY_HISTORY_SQL, [
    query.addresses, from, coverage.through,
    query.granularityMinutes, query.minuteStartsAt, query.limit + 1, null, null,
  ]);
  const comparableAggregates = aggregateRows.filter((row) => new Date(row.bucket_ts) >= from);
  return {
    value: compareShadowRows(comparableAggregates, legacy.rows),
    durationMs: Date.now() - startedAt,
  };
}

async function readCoveredHistories(query, execute, rollout, startedAt, queryStartedAt) {
  const coverage = resolveReadCoverage(query, rollout);
  const useAggregates = coverage != null;
  const aggregateResult = useAggregates
    ? await execute(AGGREGATE_HISTORY_SQL, [
      query.addresses, coverage.from, coverage.through,
      query.granularityMinutes, query.limit + 1,
    ])
    : { rows: [] };
  const shouldFallback = !useAggregates || !coversQuery(query, coverage);
  const fallbackAddresses = shouldFallback ? query.addresses : [];
  const fallbackResult = shouldFallback
    ? await execute(LEGACY_HISTORY_SQL, [
      fallbackAddresses, query.startAt, query.endAt, query.granularityMinutes,
      query.minuteStartsAt, query.limit + 1,
      useAggregates ? coverage.from : null,
      useAggregates ? coverage.through : null,
    ])
    : { rows: [] };
  const shadow = await readShadowComparison(
    query, execute, coverage, aggregateResult.rows, rollout.shadowCompareEnabled
  );
  const queryDurationMs = Date.now() - queryStartedAt;
  const aggregateByAddress = groupRows(query, aggregateResult.rows);
  const fallbackByAddress = groupRows(
    { ...query, addresses: fallbackAddresses }, fallbackResult.rows
  );
  const buildStartedAt = Date.now();
  const histories = Object.freeze(query.addresses.map((address) => (
    buildHistoryResult(query, address, mergeRows(
      aggregateByAddress.get(address) || [], fallbackByAddress.get(address) || []
    ))
  )));
  return {
    histories,
    metrics: {
      source: !useAggregates ? 'legacy' : shouldFallback ? 'mixed' : 'aggregate',
      rows: aggregateResult.rows.length + fallbackResult.rows.length,
      aggregateRows: aggregateResult.rows.length,
      fallbackRows: fallbackResult.rows.length,
      fallbackAddresses: fallbackAddresses.length,
      aggregateCoverageFrom: coverage?.from.toISOString() || null,
      aggregateCoverageThrough: coverage?.through.toISOString() || null,
      shadow: shadow.value,
      shadowDurationMs: shadow.durationMs,
      cacheHit: false,
      queryDurationMs,
      buildDurationMs: Date.now() - buildStartedAt,
      totalDurationMs: Date.now() - startedAt,
    },
  };
}

function createRobinhoodMarketHistoryReadRepository(options = {}) {
  const database = options.database || db;
  const clock = options.now || (() => new Date());
  const aggregateReadsEnabled = options.aggregateReadsEnabled === true;
  const fallbackEnabled = options.fallbackEnabled !== false;
  const shadowCompareEnabled = options.shadowCompareEnabled === true;
  const verifiedCoverage = normalizeVerifiedCoverage(options.verifiedCoverage);
  const rollout = {
    aggregateReadsEnabled, fallbackEnabled, shadowCompareEnabled, verifiedCoverage,
  };
  const cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
  const cache = new Map();

  function readCache(key, nowMs, onMetrics) {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= nowMs) {
      if (entry) cache.delete(key);
      return null;
    }
    onMetrics?.({ ...entry.metrics, cacheHit: true, totalDurationMs: 0 });
    return entry.histories;
  }

  function writeCache(key, histories, metrics, nowMs) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { histories, metrics, expiresAt: nowMs + cacheTtlMs });
  }

  async function getHistories(input = {}) {
    const startedAt = Date.now();
    const now = timestamp(clock(), 'now');
    const query = normalizeQuery(input, now);
    const cacheKey = buildCacheKey(query, cacheTtlMs, rollout);
    const cached = readCache(cacheKey, now.getTime(), query.onMetrics);
    if (cached) return cached;
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, params) => database.queryWithStatementTimeout(
        sql, params, query.statementTimeoutMs,
      )
      : (sql, params) => database.query(sql, params);
    const queryStartedAt = Date.now();
    if (query.allAvailable) {
      const exactAggregates = isRobinhoodFullHistoryGranularityMinutes(
        query.granularityMinutes,
      );
      const result = exactAggregates
        ? await execute(AGGREGATE_HISTORY_SQL, [
          query.addresses, query.startAt, query.endAt,
          query.granularityMinutes, query.limit + 1,
        ])
        : await execute(ALL_AVAILABLE_HISTORY_SQL, [
          query.addresses, query.endAt, query.limit,
        ]);
      const rowsByAddress = groupRows(query, result.rows);
      const histories = Object.freeze(query.addresses.map((address) => (
        buildHistoryResult(query, address, rowsByAddress.get(address) || [])
      )));
      const metrics = {
        source: exactAggregates ? 'aggregate-all-exact' : 'hourly-all-sampled',
        rows: result.rows.length,
        aggregateRows: exactAggregates ? result.rows.length : 0, fallbackRows: 0,
        fallbackAddresses: 0, cacheHit: false,
        queryDurationMs: Date.now() - queryStartedAt,
        buildDurationMs: 0,
        totalDurationMs: Date.now() - startedAt,
      };
      writeCache(cacheKey, histories, metrics, now.getTime());
      query.onMetrics?.(metrics);
      return histories;
    }
    const { histories, metrics } = await readCoveredHistories(
      query, execute, rollout, startedAt, queryStartedAt
    );
    writeCache(cacheKey, histories, metrics, now.getTime());
    query.onMetrics?.(metrics);
    return histories;
  }

  async function getHistory(input = {}) {
    const [history] = await getHistories({ ...input, addresses: [input.address] });
    return history;
  }

  return Object.freeze({ getHistories, getHistory });
}

module.exports = {
  createRobinhoodMarketHistoryReadRepository,
  __private: {
    AGGREGATE_HISTORY_SQL, ALL_AVAILABLE_HISTORY_SQL, LEGACY_HISTORY_SQL, buildHistoryResult,
    compareShadowRows, intersectCoverage, mergeRows, normalizeAddresses, normalizeCandle,
    normalizeQuery, normalizeVerifiedCoverage, readCoveredHistories, resolveResolution,
  },
};
