const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MINUTE_MS = 60_000;
const MINUTE_RETENTION_MS = 14 * 24 * 60 * MINUTE_MS;
const MAX_WINDOW_MS = 10 * 365 * 24 * 60 * MINUTE_MS;
const MAX_CANDLES = 5000;
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

function normalizeQuery(input, now) {
  const addresses = normalizeAddresses(input);
  const startAt = timestamp(input.startAt, 'startAt');
  const endAt = timestamp(input.endAt, 'endAt');
  const windowMs = endAt.getTime() - startAt.getTime();
  if (windowMs <= 0 || windowMs > MAX_WINDOW_MS) {
    throw new Error('Robinhood history window must be greater than zero and at most 10 years');
  }
  const granularityMinutes = Number(input.granularityMinutes ?? 5);
  if (!GRANULARITIES.has(granularityMinutes)) {
    throw new Error('Robinhood history granularity must be one of 1, 5, 15, 30, 60, 240, 1440');
  }
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

function buildCacheKey(query, cacheTtlMs, aggregateReadsEnabled, fallbackEnabled) {
  return JSON.stringify([
    query.addresses,
    Math.floor(query.startAt.getTime() / cacheTtlMs),
    Math.floor(query.endAt.getTime() / cacheTtlMs),
    query.granularityMinutes,
    query.limit,
    aggregateReadsEnabled,
    fallbackEnabled,
  ]);
}

function createRobinhoodMarketHistoryReadRepository(options = {}) {
  const database = options.database || db;
  const clock = options.now || (() => new Date());
  const aggregateReadsEnabled = options.aggregateReadsEnabled === true;
  const fallbackEnabled = options.fallbackEnabled !== false;
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
    const cacheKey = buildCacheKey(
      query, cacheTtlMs, aggregateReadsEnabled, fallbackEnabled,
    );
    const cached = readCache(cacheKey, now.getTime(), query.onMetrics);
    if (cached) return cached;
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, params) => database.queryWithStatementTimeout(
        sql, params, query.statementTimeoutMs,
      )
      : (sql, params) => database.query(sql, params);
    const queryStartedAt = Date.now();
    const useAggregates = aggregateReadsEnabled && query.granularityMinutes !== 1;
    const aggregateResult = useAggregates
      ? await execute(AGGREGATE_HISTORY_SQL, [
        query.addresses, query.startAt, query.endAt,
        query.granularityMinutes, query.limit + 1,
      ])
      : { rows: [] };
    const aggregateByAddress = groupRows(query, aggregateResult.rows);
    const fallbackAddresses = useAggregates
      ? query.addresses.filter((address) => aggregateByAddress.get(address).length === 0)
      : query.addresses;
    const shouldFallback = !useAggregates || (fallbackEnabled && fallbackAddresses.length > 0);
    const fallbackResult = shouldFallback
      ? await execute(LEGACY_HISTORY_SQL, [
        fallbackAddresses, query.startAt, query.endAt, query.granularityMinutes,
        query.minuteStartsAt, query.limit + 1,
      ])
      : { rows: [] };
    const fallbackQuery = { ...query, addresses: fallbackAddresses };
    const fallbackByAddress = groupRows(fallbackQuery, fallbackResult.rows);
    const queryDurationMs = Date.now() - queryStartedAt;
    const buildStartedAt = Date.now();
    const histories = Object.freeze(query.addresses.map((address) => {
      const aggregateRows = aggregateByAddress.get(address);
      const rows = aggregateRows.length > 0
        ? aggregateRows : (fallbackByAddress.get(address) || []);
      return buildHistoryResult(query, address, rows);
    }));
    const usedFallbackAddresses = shouldFallback ? fallbackAddresses.length : 0;
    const metrics = {
      source: !useAggregates ? 'legacy' : usedFallbackAddresses > 0
        ? (usedFallbackAddresses === query.addresses.length ? 'fallback' : 'mixed')
        : 'aggregate',
      rows: aggregateResult.rows.length + fallbackResult.rows.length,
      aggregateRows: aggregateResult.rows.length,
      fallbackRows: fallbackResult.rows.length,
      fallbackAddresses: usedFallbackAddresses,
      cacheHit: false,
      queryDurationMs,
      buildDurationMs: Date.now() - buildStartedAt,
      totalDurationMs: Date.now() - startedAt,
    };
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
    AGGREGATE_HISTORY_SQL, LEGACY_HISTORY_SQL, buildHistoryResult,
    normalizeAddresses, normalizeCandle, normalizeQuery, resolveResolution,
  },
};
