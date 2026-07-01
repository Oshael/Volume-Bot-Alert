const db = require('../models/db');
const { AGGREGATE_GRANULARITY_MINUTES } = require('./market-bucket-granularities');

const DEFAULT_LOOKBACK_HOURS = 14 * 24;
const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_WINDOW_HOURS = 24;
const SUPPORTED_GRANULARITIES = AGGREGATE_GRANULARITY_MINUTES;

function parseBooleanFlag(value) {
  return value === true || value === 'true' || value === '1';
}

function parseOptionalInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function parseGranularities(value) {
  if (value == null || value === '' || value === true) {
    return [...SUPPORTED_GRANULARITIES];
  }

  const parsed = String(value)
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item));
  const unique = Array.from(new Set(parsed));
  if (!unique.length || unique.some((item) => !SUPPORTED_GRANULARITIES.includes(item))) {
    throw new Error(`granularity must be one of ${SUPPORTED_GRANULARITIES.join(', ')}`);
  }

  return unique;
}

function parseOptionalDate(value, name) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} must be a valid date or timestamp`);
  }
  return date;
}

function parseWindowOptions(args) {
  const startDate = parseOptionalDate(args.startDate, 'startDate');
  const endDate = parseOptionalDate(args.endDate, 'endDate');

  if (Boolean(startDate) !== Boolean(endDate)) {
    throw new Error('startDate and endDate must be provided together');
  }
  if (startDate && endDate && startDate >= endDate) {
    throw new Error('startDate must be before endDate');
  }

  return {
    windowHours: parseOptionalInteger(args.windowHours, 'windowHours', { min: 1, max: 24 * 31 }) || DEFAULT_WINDOW_HOURS,
    sleepMs: parseOptionalInteger(args.sleepMs, 'sleepMs', { min: 0, max: 60_000 }) || 0,
    statementTimeoutMs: parseOptionalInteger(args.statementTimeoutMs, 'statementTimeoutMs', { min: 0, max: 10 * 60_000 }) || 0,
    startDate,
    endDate,
  };
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;

    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  const hours = parseOptionalInteger(args.hours, 'hours', { min: 1, max: 24 * 365 });
  const days = parseOptionalInteger(args.days, 'days', { min: 1, max: 365 });
  const limitAddresses = parseOptionalInteger(args.limitAddresses, 'limitAddresses', { min: 1, max: 1000000 });
  const batchSize = parseOptionalInteger(args.batchSize, 'batchSize', { min: 1, max: 5000 }) || DEFAULT_BATCH_SIZE;
  const windowOptions = parseWindowOptions(args);
  const all = parseBooleanFlag(args.all);
  const dryRun = parseBooleanFlag(args.dryRun);
  const resetRange = parseBooleanFlag(args.resetRange);

  let lookbackHours = hours;
  if (lookbackHours == null && days != null) {
    lookbackHours = days * 24;
  }
  if (lookbackHours == null && !all) {
    lookbackHours = DEFAULT_LOOKBACK_HOURS;
  }

  return {
    all,
    lookbackHours,
    limitAddresses,
    batchSize,
    ...windowOptions,
    dryRun,
    resetRange,
    afterAddress: String(args.afterAddress || '').trim() || null,
    granularities: parseGranularities(args.granularity),
  };
}

function isWindowedMode(options) {
  return options?.startDate instanceof Date && options?.endDate instanceof Date;
}

function queryWithOptionalTimeout(sql, params, options = {}) {
  const timeoutMs = Math.max(0, Number(options.statementTimeoutMs) || 0);
  if (timeoutMs > 0 && typeof db.queryWithStatementTimeout === 'function') {
    return db.queryWithStatementTimeout(sql, params, timeoutMs);
  }
  return db.query(sql, params);
}

function sleep(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  return safeMs > 0 ? new Promise((resolve) => setTimeout(resolve, safeMs)) : Promise.resolve();
}

function buildLookbackClause(options, tableAlias = 'b', params = []) {
  if (options.all || !Number.isInteger(options.lookbackHours)) {
    return { sql: '', params };
  }

  params.push(options.lookbackHours);
  return {
    sql: `AND ${tableAlias}.bucket_ts >= NOW() - ($${params.length}::int * INTERVAL '1 hour')`,
    params,
  };
}

async function listCandidateAddresses(options, afterAddress = null) {
  const params = [];
  const clauses = [
    '(b.close_mcap IS NOT NULL OR b.close_price IS NOT NULL)',
  ];

  const lookback = buildLookbackClause(options, 'b', params);
  if (lookback.sql) {
    clauses.push(lookback.sql.slice(4));
  }
  if (afterAddress) {
    params.push(afterAddress);
    clauses.push(`b.token_address > $${params.length}`);
  }

  params.push(Math.max(1, Number(options.batchSize) || DEFAULT_BATCH_SIZE));
  const batchLimitParam = params.length;

  const limitAddresses = Number.isInteger(options.limitAddresses)
    ? Math.max(0, options.limitAddresses - (Number(options.processedAddressCount) || 0))
    : null;
  const effectiveLimit = limitAddresses == null
    ? params[batchLimitParam - 1]
    : Math.min(params[batchLimitParam - 1], limitAddresses);
  params[batchLimitParam - 1] = effectiveLimit;

  if (effectiveLimit <= 0) {
    return [];
  }

  const result = await queryWithOptionalTimeout(
    `SELECT DISTINCT b.token_address
     FROM token_market_buckets_1m b
     WHERE ${clauses.join(' AND ')}
     ORDER BY b.token_address ASC
     LIMIT $${batchLimitParam}::int`,
    params,
    options
  );

  return result.rows.map((row) => String(row.token_address || '').trim()).filter(Boolean);
}

async function countCandidateAddresses(options) {
  const params = [];
  const clauses = [
    '(b.close_mcap IS NOT NULL OR b.close_price IS NOT NULL)',
  ];
  const lookback = buildLookbackClause(options, 'b', params);
  if (lookback.sql) {
    clauses.push(lookback.sql.slice(4));
  }

  const limitSql = Number.isInteger(options.limitAddresses)
    ? `LIMIT ${Math.max(1, options.limitAddresses)}`
    : '';
  const result = await queryWithOptionalTimeout(
    `SELECT COUNT(*)::int AS address_count
     FROM (
       SELECT DISTINCT b.token_address
       FROM token_market_buckets_1m b
       WHERE ${clauses.join(' AND ')}
       ORDER BY b.token_address ASC
       ${limitSql}
     ) candidates`,
    params,
    options
  );

  return Number(result.rows[0]?.address_count) || 0;
}

async function resetAggregateBuckets(addresses, granularityMinutes, options) {
  if (!Array.isArray(addresses) || !addresses.length) {
    return 0;
  }

  const params = [addresses, granularityMinutes];
  const lookback = buildLookbackClause(options, 'agg', params);
  const result = await queryWithOptionalTimeout(
    `DELETE FROM token_market_buckets_agg agg
     WHERE agg.token_address = ANY($1::varchar[])
       AND agg.granularity_minutes = $2::int
       ${lookback.sql}`,
    lookback.params,
    options
  );

  return result.rowCount || 0;
}

async function backfillAggregateBuckets(addresses, granularityMinutes, options) {
  if (!Array.isArray(addresses) || !addresses.length) {
    return 0;
  }

  const params = [addresses, granularityMinutes];
  const lookback = buildLookbackClause(options, 'b', params);
  const result = await queryWithOptionalTimeout(
    `WITH source_rows AS (
       SELECT
         b.token_address,
         to_timestamp(
           FLOOR(EXTRACT(EPOCH FROM b.bucket_ts) / ($2::int * 60)) * ($2::int * 60)
         ) AS aggregate_bucket_ts,
         b.bucket_ts,
         b.pair_address,
         b.open_mcap,
         b.high_mcap,
         b.low_mcap,
         b.close_mcap,
         b.open_price,
         b.high_price,
         b.low_price,
         b.close_price,
         b.sample_count
       FROM token_market_buckets_1m b
       WHERE b.token_address = ANY($1::varchar[])
         AND (b.close_mcap IS NOT NULL OR b.close_price IS NOT NULL)
         ${lookback.sql}
     ),
     aggregated AS (
       SELECT
         token_address,
         $2::int AS granularity_minutes,
         aggregate_bucket_ts AS bucket_ts,
         (ARRAY_AGG(pair_address ORDER BY bucket_ts DESC) FILTER (WHERE pair_address IS NOT NULL))[1] AS pair_address,
         (ARRAY_AGG(open_mcap ORDER BY bucket_ts ASC) FILTER (WHERE open_mcap IS NOT NULL))[1] AS open_mcap,
         MAX(high_mcap) AS high_mcap,
         MIN(low_mcap) AS low_mcap,
         (ARRAY_AGG(close_mcap ORDER BY bucket_ts DESC) FILTER (WHERE close_mcap IS NOT NULL))[1] AS close_mcap,
         (ARRAY_AGG(open_price ORDER BY bucket_ts ASC) FILTER (WHERE open_price IS NOT NULL))[1] AS open_price,
         MAX(high_price) AS high_price,
         MIN(low_price) AS low_price,
         (ARRAY_AGG(close_price ORDER BY bucket_ts DESC) FILTER (WHERE close_price IS NOT NULL))[1] AS close_price,
         COALESCE(SUM(sample_count), 0)::int AS sample_count
       FROM source_rows
       GROUP BY token_address, aggregate_bucket_ts
     )
     INSERT INTO token_market_buckets_agg (
       token_address,
       granularity_minutes,
       bucket_ts,
       pair_address,
       open_mcap,
       high_mcap,
       low_mcap,
       close_mcap,
       open_price,
       high_price,
       low_price,
       close_price,
       sample_count,
       source
     )
     SELECT
       token_address,
       granularity_minutes,
       bucket_ts,
       pair_address,
       open_mcap,
       high_mcap,
       low_mcap,
       close_mcap,
       open_price,
       high_price,
       low_price,
       close_price,
       sample_count,
       'aggregate_backfill'
     FROM aggregated
     ON CONFLICT (token_address, granularity_minutes, bucket_ts) DO UPDATE SET
       pair_address = COALESCE(EXCLUDED.pair_address, token_market_buckets_agg.pair_address),
       open_mcap = EXCLUDED.open_mcap,
       high_mcap = EXCLUDED.high_mcap,
       low_mcap = EXCLUDED.low_mcap,
       close_mcap = EXCLUDED.close_mcap,
       open_price = EXCLUDED.open_price,
       high_price = EXCLUDED.high_price,
       low_price = EXCLUDED.low_price,
       close_price = EXCLUDED.close_price,
       sample_count = EXCLUDED.sample_count,
       source = EXCLUDED.source,
       updated_at = NOW()`,
    lookback.params,
    options
  );

  return result.rowCount || 0;
}

async function resetAggregateBucketsForWindow(granularityMinutes, windowStart, windowEnd, options = {}) {
  const result = await queryWithOptionalTimeout(
    `DELETE FROM token_market_buckets_agg
     WHERE granularity_minutes = $1::int
       AND bucket_ts >= $2::timestamptz
       AND bucket_ts < $3::timestamptz`,
    [granularityMinutes, windowStart, windowEnd],
    options
  );

  return result.rowCount || 0;
}

async function backfillAggregateBucketsForWindow(granularityMinutes, windowStart, windowEnd, options = {}) {
  const result = await queryWithOptionalTimeout(
    `WITH source_rows AS (
       SELECT
         b.token_address,
         to_timestamp(
           FLOOR(EXTRACT(EPOCH FROM b.bucket_ts) / ($1::int * 60)) * ($1::int * 60)
         ) AS aggregate_bucket_ts,
         b.bucket_ts,
         b.pair_address,
         b.open_mcap,
         b.high_mcap,
         b.low_mcap,
         b.close_mcap,
         b.open_price,
         b.high_price,
         b.low_price,
         b.close_price,
         b.sample_count
       FROM token_market_buckets_1m b
       WHERE b.bucket_ts >= $2::timestamptz
         AND b.bucket_ts < $3::timestamptz
         AND (b.close_mcap IS NOT NULL OR b.close_price IS NOT NULL)
     ),
     aggregated AS (
       SELECT
         token_address,
         $1::int AS granularity_minutes,
         aggregate_bucket_ts AS bucket_ts,
         (ARRAY_AGG(pair_address ORDER BY bucket_ts DESC) FILTER (WHERE pair_address IS NOT NULL))[1] AS pair_address,
         (ARRAY_AGG(open_mcap ORDER BY bucket_ts ASC) FILTER (WHERE open_mcap IS NOT NULL))[1] AS open_mcap,
         MAX(high_mcap) AS high_mcap,
         MIN(low_mcap) AS low_mcap,
         (ARRAY_AGG(close_mcap ORDER BY bucket_ts DESC) FILTER (WHERE close_mcap IS NOT NULL))[1] AS close_mcap,
         (ARRAY_AGG(open_price ORDER BY bucket_ts ASC) FILTER (WHERE open_price IS NOT NULL))[1] AS open_price,
         MAX(high_price) AS high_price,
         MIN(low_price) AS low_price,
         (ARRAY_AGG(close_price ORDER BY bucket_ts DESC) FILTER (WHERE close_price IS NOT NULL))[1] AS close_price,
         COALESCE(SUM(sample_count), 0)::int AS sample_count
       FROM source_rows
       GROUP BY token_address, aggregate_bucket_ts
     )
     INSERT INTO token_market_buckets_agg (
       token_address,
       granularity_minutes,
       bucket_ts,
       pair_address,
       open_mcap,
       high_mcap,
       low_mcap,
       close_mcap,
       open_price,
       high_price,
       low_price,
       close_price,
       sample_count,
       source
     )
     SELECT
       token_address,
       granularity_minutes,
       bucket_ts,
       pair_address,
       open_mcap,
       high_mcap,
       low_mcap,
       close_mcap,
       open_price,
       high_price,
       low_price,
       close_price,
       sample_count,
       'aggregate_window_backfill'
     FROM aggregated
     ON CONFLICT (token_address, granularity_minutes, bucket_ts) DO UPDATE SET
       pair_address = COALESCE(EXCLUDED.pair_address, token_market_buckets_agg.pair_address),
       open_mcap = EXCLUDED.open_mcap,
       high_mcap = EXCLUDED.high_mcap,
       low_mcap = EXCLUDED.low_mcap,
       close_mcap = EXCLUDED.close_mcap,
       open_price = EXCLUDED.open_price,
       high_price = EXCLUDED.high_price,
       low_price = EXCLUDED.low_price,
       close_price = EXCLUDED.close_price,
       sample_count = EXCLUDED.sample_count,
       source = EXCLUDED.source,
       updated_at = NOW()`,
    [granularityMinutes, windowStart, windowEnd],
    options
  );

  return result.rowCount || 0;
}

async function runBackfill(options) {
  let afterAddress = options.afterAddress;
  let processedAddressCount = 0;
  let totalAggregateRows = 0;

  while (true) {
    const addresses = await listCandidateAddresses({ ...options, processedAddressCount }, afterAddress);
    if (!addresses.length) break;

    for (const granularity of options.granularities) {
      if (options.resetRange && !options.dryRun) {
        const deleted = await resetAggregateBuckets(addresses, granularity, options);
        console.log(`[BackfillBucketsAgg] Reset ${granularity}m rows for batch: ${deleted}`);
      }
      if (!options.dryRun) {
        totalAggregateRows += await backfillAggregateBuckets(addresses, granularity, options);
      }
    }

    processedAddressCount += addresses.length;
    afterAddress = addresses[addresses.length - 1];
    console.log(`[BackfillBucketsAgg] Batch done. addresses=${processedAddressCount} cursor=${afterAddress}`);
  }

  return { processedAddressCount, totalAggregateRows, nextAfterAddress: afterAddress };
}

async function runWindowedBackfill(options) {
  const windowHours = Math.max(1, Number(options.windowHours) || DEFAULT_WINDOW_HOURS);
  const windowMs = windowHours * 60 * 60 * 1000;
  const endMs = options.endDate.getTime();
  let cursorMs = options.startDate.getTime();
  let processedWindowCount = 0;
  let totalAggregateRows = 0;

  while (cursorMs < endMs) {
    const windowStart = new Date(cursorMs);
    const windowEnd = new Date(Math.min(cursorMs + windowMs, endMs));

    for (const granularity of options.granularities) {
      if (options.resetRange && !options.dryRun) {
        const deleted = await resetAggregateBucketsForWindow(granularity, windowStart, windowEnd, options);
        console.log(`[BackfillBucketsAgg] Reset ${granularity}m rows for window ${windowStart.toISOString()}..${windowEnd.toISOString()}: ${deleted}`);
      }
      if (!options.dryRun) {
        const touched = await backfillAggregateBucketsForWindow(granularity, windowStart, windowEnd, options);
        totalAggregateRows += touched;
        console.log(`[BackfillBucketsAgg] Window ${windowStart.toISOString()}..${windowEnd.toISOString()} ${granularity}m rows touched: ${touched}`);
      } else {
        console.log(`[BackfillBucketsAgg] Dry window ${windowStart.toISOString()}..${windowEnd.toISOString()} ${granularity}m`);
      }
    }

    processedWindowCount += 1;
    cursorMs = windowEnd.getTime();
    if (cursorMs < endMs) {
      await sleep(options.sleepMs);
    }
  }

  return {
    processedWindowCount,
    totalAggregateRows,
    nextWindowStart: new Date(cursorMs).toISOString(),
  };
}

async function run() {
  try {
    const options = parseCliArgs();
    const scopeLabel = isWindowedMode(options)
      ? `${options.startDate.toISOString()}..${options.endDate.toISOString()} in ${options.windowHours}h windows`
      : options.all
      ? 'all available 1m market bucket history'
      : `last ${options.lookbackHours}h of 1m market bucket history`;

    console.log(`[BackfillBucketsAgg] Scope: ${scopeLabel}`);
    console.log(`[BackfillBucketsAgg] Granularities: ${options.granularities.join(', ')}m`);
    if (isWindowedMode(options)) {
      console.log(`[BackfillBucketsAgg] Sleep between windows: ${options.sleepMs}ms`);
    } else {
      console.log(`[BackfillBucketsAgg] Batch size: ${options.batchSize}`);
    }
    if (!isWindowedMode(options) && options.afterAddress) {
      console.log(`[BackfillBucketsAgg] Resuming after address: ${options.afterAddress}`);
    }

    if (options.dryRun) {
      console.log('[BackfillBucketsAgg] Dry run enabled. Batches will be scanned but no aggregate rows written.');
    }

    const startedAt = Date.now();
    const result = isWindowedMode(options)
      ? await runWindowedBackfill(options)
      : await runBackfillWithCandidateCount(options);
    console.log(`[BackfillBucketsAgg] Backfill completed in ${Date.now() - startedAt}ms`);
    if (isWindowedMode(options)) {
      console.log(`[BackfillBucketsAgg] Processed windows: ${result.processedWindowCount}`);
    } else {
      console.log(`[BackfillBucketsAgg] Processed addresses: ${result.processedAddressCount}`);
    }
    console.log(`[BackfillBucketsAgg] Aggregate rows touched: ${result.totalAggregateRows}`);
    if (result.nextAfterAddress) {
      console.log(`[BackfillBucketsAgg] Last cursor: ${result.nextAfterAddress}`);
    }
  } catch (err) {
    console.error('[BackfillBucketsAgg] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

async function runBackfillWithCandidateCount(options) {
  const candidateAddressCount = await countCandidateAddresses(options);
  console.log(`[BackfillBucketsAgg] Candidate addresses: ${candidateAddressCount}`);
  return runBackfill(options);
}

if (require.main === module) {
  run();
}

module.exports = {
  run,
  __private: {
    backfillAggregateBuckets,
    backfillAggregateBucketsForWindow,
    countCandidateAddresses,
    listCandidateAddresses,
    parseCliArgs,
    parseOptionalDate,
    parseGranularities,
    parseOptionalInteger,
    resetAggregateBuckets,
    resetAggregateBucketsForWindow,
    runBackfill,
    runWindowedBackfill,
  },
};
