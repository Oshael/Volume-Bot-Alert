const fs = require('fs/promises');
const path = require('path');
const {
  buildNormalizedOhlcHighSql,
  buildNormalizedOhlcLowSql,
} = require('../utils/market-bucket-ohlc');
const { ONE_MINUTE_PROTECTION_DAYS } = require('./coingecko-chart-backfill-plan');

const DEFAULT_BATCH_SIZE = 500;
const AGGREGATE_REBUILD_TARGETS = Object.freeze([5, 15, 30, 60, 240, 1440]);

function normalizeString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function getReplaceRange(plan) {
  const from = normalizeString(plan?.replaceImpact?.range?.firstBucketAt);
  const to = normalizeString(plan?.replaceImpact?.range?.latestBucketAt);
  if (!from || !to) {
    throw new Error('Replace range is required');
  }
  return { from, to };
}

function buildBackupFilename(tokenAddress, now = new Date()) {
  const safeToken = normalizeString(tokenAddress).replace(/[^a-zA-Z0-9_-]/g, '_');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${safeToken}-coingecko-replace-backup-${stamp}.json`;
}

function getTargetGranularityMinutes(plan) {
  const granularity = Number(plan?.request?.granularityMinutes);
  if (![1, 5].includes(granularity)) {
    throw new Error(`Unsupported replace granularity: ${granularity}`);
  }
  return granularity;
}

function assertOneMinuteRangeIsNotProtected(range, granularityMinutes, now = new Date()) {
  if (granularityMinutes !== 1) return;

  const nowMs = new Date(now).getTime();
  const latestMs = Date.parse(range.to);
  if (!Number.isFinite(nowMs) || !Number.isFinite(latestMs)) {
    throw new Error('Valid replace range and current time are required');
  }
  const cutoffMs = nowMs - (ONE_MINUTE_PROTECTION_DAYS * 24 * 60 * 60 * 1000);
  if (latestMs >= cutoffMs) {
    throw new Error(`Refusing to overwrite protected 1m candles from the last ${ONE_MINUTE_PROTECTION_DAYS} days`);
  }
}

function getAffectedAggregateGranularities(granularityMinutes) {
  return AGGREGATE_REBUILD_TARGETS.filter((target) => target >= granularityMinutes);
}

async function loadExistingBuckets(client, tokenAddress, range, granularityMinutes) {
  if (granularityMinutes === 1) {
    const baseResult = await client.query(
      `SELECT
         token_address,
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
       FROM token_market_buckets_1m
       WHERE token_address = $1
         AND bucket_ts >= $2::timestamptz
         AND bucket_ts <= $3::timestamptz
      ORDER BY bucket_ts ASC`,
      [tokenAddress, range.from, range.to]
    );
    const affectedGranularities = getAffectedAggregateGranularities(1);
    const aggregateRange = getAlignedRange(range, Math.max(...affectedGranularities));
    const aggregateResult = await loadExistingAggregateBuckets(
      client,
      tokenAddress,
      { from: aggregateRange.from, to: aggregateRange.toExclusive },
      affectedGranularities
    );
    return {
      tokenMarketBuckets1m: baseResult.rows || [],
      tokenMarketBucketsAgg: aggregateResult.rows || [],
    };
  }

  const affectedGranularities = getAffectedAggregateGranularities(granularityMinutes);
  const aggregateRange = getAlignedRange(range, Math.max(...affectedGranularities));
  const aggregateResult = await loadExistingAggregateBuckets(
    client,
    tokenAddress,
    { from: aggregateRange.from, to: aggregateRange.toExclusive },
    affectedGranularities
  );

  return {
    tokenMarketBuckets1m: [],
    tokenMarketBucketsAgg: aggregateResult.rows || [],
  };
}

async function loadExistingAggregateBuckets(client, tokenAddress, range, granularities) {
  return client.query(
    `SELECT
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
         source,
         created_at,
         updated_at
       FROM token_market_buckets_agg
       WHERE token_address = $1
         AND granularity_minutes = ANY($4::int[])
         AND bucket_ts >= $2::timestamptz
         AND bucket_ts < $3::timestamptz
       ORDER BY granularity_minutes ASC, bucket_ts ASC`,
    [tokenAddress, range.from, range.to, granularities]
  );
}

function buildBackupPayload({ plan, existingBuckets, generatedAt }) {
  return {
    generatedAt,
    operation: 'coingecko_replace_chart_backup',
    token: plan.token,
    poolAddress: plan.poolAddress,
    granularityMinutes: plan.request.granularityMinutes,
    range: plan.replaceImpact.range,
    counts: {
      tokenMarketBuckets1m: existingBuckets.tokenMarketBuckets1m.length,
      tokenMarketBucketsAgg: existingBuckets.tokenMarketBucketsAgg.length,
    },
    tokenMarketBuckets1m: existingBuckets.tokenMarketBuckets1m,
    tokenMarketBucketsAgg: existingBuckets.tokenMarketBucketsAgg,
  };
}

async function writeBackupFile({ fsImpl = fs, backupDir, tokenAddress, payload, now = new Date() }) {
  const resolvedDir = path.resolve(backupDir);
  await fsImpl.mkdir(resolvedDir, { recursive: true });
  const backupPath = path.join(resolvedDir, buildBackupFilename(tokenAddress, now));
  await fsImpl.writeFile(backupPath, `${JSON.stringify(payload, null, 2)}\n`);
  return backupPath;
}

async function deleteExistingRows(client, tokenAddress, range, granularityMinutes) {
  const table = granularityMinutes === 1 ? 'token_market_buckets_1m' : 'token_market_buckets_agg';
  const granularityFilter = granularityMinutes === 1 ? '' : '\n       AND granularity_minutes = $4::int';
  const params = granularityMinutes === 1
    ? [tokenAddress, range.from, range.to]
    : [tokenAddress, range.from, range.to, granularityMinutes];
  const result = await client.query(
    `DELETE FROM ${table}
     WHERE token_address = $1
       AND bucket_ts >= $2::timestamptz
       AND bucket_ts <= $3::timestamptz${granularityFilter}`,
    params
  );
  return {
    tokenMarketBucketsAggDeleted: granularityMinutes === 1 ? 0 : (result.rowCount || 0),
    tokenMarketBuckets1mDeleted: granularityMinutes === 1 ? (result.rowCount || 0) : 0,
  };
}

function buildInsertBatch(buckets, granularityMinutes) {
  const columnsPerRow = granularityMinutes === 1 ? 13 : 14;
  const params = [];
  const valuesSql = buckets.map((bucket, index) => {
    const offset = index * columnsPerRow;
    params.push(
      bucket.tokenAddress,
      ...(granularityMinutes === 1 ? [] : [granularityMinutes]),
      bucket.bucketTs,
      bucket.pairAddress,
      bucket.openMcap,
      bucket.highMcap,
      bucket.lowMcap,
      bucket.closeMcap,
      bucket.openPrice,
      bucket.highPrice,
      bucket.lowPrice,
      bucket.closePrice,
      bucket.sampleCount,
      bucket.source
    );
    const values = Array.from({ length: columnsPerRow }, (_, paramIndex) => {
      const position = offset + paramIndex + 1;
      const timestampIndex = granularityMinutes === 1 ? 2 : 3;
      return position === offset + timestampIndex ? `$${position}::timestamptz` : `$${position}`;
    });
    return `(${values.join(', ')})`;
  }).join(',\n');

  return { params, valuesSql };
}

async function insertBackfillBuckets(client, buckets, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize) || DEFAULT_BATCH_SIZE);
  const granularityMinutes = Number(options.granularityMinutes);
  const targetTable = granularityMinutes === 1 ? 'token_market_buckets_1m' : 'token_market_buckets_agg';
  const granularityColumn = granularityMinutes === 1 ? '' : '\n         granularity_minutes,';
  const conflictColumns = granularityMinutes === 1
    ? 'token_address, bucket_ts'
    : 'token_address, granularity_minutes, bucket_ts';
  const conflictAction = options.conflictMode === 'ignore'
    ? `ON CONFLICT (${conflictColumns}) DO NOTHING`
    : `ON CONFLICT (${conflictColumns}) DO UPDATE SET
         pair_address = COALESCE(EXCLUDED.pair_address, ${targetTable}.pair_address),
         open_mcap = EXCLUDED.open_mcap,
         high_mcap = EXCLUDED.high_mcap,
         low_mcap = EXCLUDED.low_mcap,
         close_mcap = EXCLUDED.close_mcap,
         open_price = EXCLUDED.open_price,
         high_price = EXCLUDED.high_price,
         low_price = EXCLUDED.low_price,
         close_price = EXCLUDED.close_price,
         sample_count = EXCLUDED.sample_count,
         source = EXCLUDED.source${granularityMinutes === 1 ? '' : ',\n         updated_at = NOW()'}`;
  let insertedOrUpdated = 0;
  for (let index = 0; index < buckets.length; index += batchSize) {
    const batch = buckets.slice(index, index + batchSize);
    if (!batch.length) continue;
    const { params, valuesSql } = buildInsertBatch(batch, granularityMinutes);
    const result = await client.query(
      `INSERT INTO ${targetTable} (
         token_address,${granularityColumn}
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
       VALUES ${valuesSql}
       ${conflictAction}`,
      params
    );
    insertedOrUpdated += result.rowCount || 0;
  }
  return insertedOrUpdated;
}

function getAlignedRange(range, granularityMinutes) {
  const bucketMs = granularityMinutes * 60 * 1000;
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new Error('Valid ordered replace range is required');
  }
  return {
    from: new Date(Math.floor(fromMs / bucketMs) * bucketMs).toISOString(),
    toExclusive: new Date((Math.floor(toMs / bucketMs) + 1) * bucketMs).toISOString(),
  };
}

function getRollupSourceGranularity(sourceGranularityMinutes, targetGranularityMinutes) {
  if (sourceGranularityMinutes === 1 && targetGranularityMinutes < 60) return 1;
  return 5;
}

function buildAggregateRollupSql(sourceGranularityMinutes) {
  const sourceTable = sourceGranularityMinutes === 1
    ? 'token_market_buckets_1m'
    : 'token_market_buckets_agg';
  const sourceFilter = sourceGranularityMinutes === 1 ? '' : '\n         AND granularity_minutes = $5::int';
  return `WITH source_rows AS (
       SELECT
         token_address,
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
         sample_count
       FROM ${sourceTable}
       WHERE token_address = $1
         AND bucket_ts >= $2::timestamptz
         AND bucket_ts < $3::timestamptz${sourceFilter}
         AND (close_mcap IS NOT NULL OR close_price IS NOT NULL)
     ), aggregated AS (
       SELECT
         token_address,
         $4::int AS granularity_minutes,
         to_timestamp(FLOOR(EXTRACT(EPOCH FROM bucket_ts) / ($4::int * 60)) * ($4::int * 60)) AS bucket_ts,
         (ARRAY_AGG(pair_address ORDER BY bucket_ts DESC) FILTER (WHERE pair_address IS NOT NULL))[1] AS pair_address,
         (ARRAY_AGG(open_mcap ORDER BY bucket_ts ASC) FILTER (WHERE open_mcap IS NOT NULL))[1] AS open_mcap,
         MAX(${buildNormalizedOhlcHighSql()}) AS high_mcap,
         MIN(${buildNormalizedOhlcLowSql()}) AS low_mcap,
         (ARRAY_AGG(close_mcap ORDER BY bucket_ts DESC) FILTER (WHERE close_mcap IS NOT NULL))[1] AS close_mcap,
         (ARRAY_AGG(open_price ORDER BY bucket_ts ASC) FILTER (WHERE open_price IS NOT NULL))[1] AS open_price,
         MAX(high_price) AS high_price,
         MIN(low_price) AS low_price,
         (ARRAY_AGG(close_price ORDER BY bucket_ts DESC) FILTER (WHERE close_price IS NOT NULL))[1] AS close_price,
         COALESCE(SUM(sample_count), 0)::int AS sample_count
       FROM source_rows
       GROUP BY token_address, granularity_minutes, to_timestamp(FLOOR(EXTRACT(EPOCH FROM bucket_ts) / ($4::int * 60)) * ($4::int * 60))
     )
     INSERT INTO token_market_buckets_agg (
       token_address, granularity_minutes, bucket_ts, pair_address,
       open_mcap, high_mcap, low_mcap, close_mcap,
       open_price, high_price, low_price, close_price, sample_count, source
     )
     SELECT
       token_address, granularity_minutes, bucket_ts, pair_address,
       open_mcap, high_mcap, low_mcap, close_mcap,
       open_price, high_price, low_price, close_price, sample_count, 'coingecko_backfill_rollup'
     FROM aggregated`;
}

async function rebuildDependentAggregates(client, tokenAddress, range, sourceGranularityMinutes) {
  const targets = getAffectedAggregateGranularities(sourceGranularityMinutes)
    .filter((target) => target > sourceGranularityMinutes);
  const rebuilt = {};
  for (const targetGranularity of targets) {
    const alignedRange = getAlignedRange(range, targetGranularity);
    await client.query(
      `DELETE FROM token_market_buckets_agg
       WHERE token_address = $1
         AND granularity_minutes = $2::int
         AND bucket_ts >= $3::timestamptz
         AND bucket_ts < $4::timestamptz`,
      [tokenAddress, targetGranularity, alignedRange.from, alignedRange.toExclusive]
    );
    const rollupSource = getRollupSourceGranularity(sourceGranularityMinutes, targetGranularity);
    const params = [tokenAddress, alignedRange.from, alignedRange.toExclusive, targetGranularity];
    if (rollupSource !== 1) params.push(rollupSource);
    const result = await client.query(buildAggregateRollupSql(rollupSource), params);
    rebuilt[String(targetGranularity)] = result.rowCount || 0;
  }
  return rebuilt;
}

function validateReplaceOptions(options) {
  const db = options.db;
  if (!db?.getClient) {
    throw new Error('db.getClient is required');
  }
  const plan = options.plan;
  const buckets = Array.isArray(options.buckets) ? options.buckets : [];
  const tokenAddress = normalizeString(plan?.token?.address);
  if (!tokenAddress) {
    throw new Error('Plan token address is required');
  }
  if (!plan?.readiness?.canReplace) {
    throw new Error(`Plan is not ready for replace: ${(plan?.readiness?.blockers || []).join(', ')}`);
  }
  if (!buckets.length) {
    throw new Error('No backfill buckets to insert');
  }
  return { db, plan, buckets, tokenAddress };
}

async function executeReplaceChart(options = {}) {
  const { db, plan, buckets, tokenAddress } = validateReplaceOptions(options);
  const range = getReplaceRange(plan);
  const granularityMinutes = getTargetGranularityMinutes(plan);
  assertOneMinuteRangeIsNotProtected(range, granularityMinutes, options.now || new Date());
  const backupDir = options.backupDir || path.resolve(process.cwd(), 'data/coingecko/backups');
  const client = await db.getClient();
  const generatedAt = new Date().toISOString();
  try {
    await client.query('BEGIN');
    const existingBuckets = await loadExistingBuckets(client, tokenAddress, range, granularityMinutes);
    const backupPayload = buildBackupPayload({ plan, existingBuckets, generatedAt });
    const backupPath = await writeBackupFile({
      fsImpl: options.fsImpl || fs,
      backupDir,
      tokenAddress,
      payload: backupPayload,
      now: new Date(generatedAt),
    });
    const deleted = await deleteExistingRows(client, tokenAddress, range, granularityMinutes);
    const insertedOrUpdated = await insertBackfillBuckets(client, buckets, {
      batchSize: options.batchSize,
      granularityMinutes,
    });
    const rebuiltAggregates = await rebuildDependentAggregates(
      client,
      tokenAddress,
      range,
      granularityMinutes
    );
    await client.query('COMMIT');
    return {
      mode: 'replace-chart',
      writes: true,
      backupPath,
      range,
      granularityMinutes,
      backedUp: backupPayload.counts,
      deleted,
      insertedOrUpdated,
      rebuiltAggregates,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ONE_MINUTE_PROTECTION_DAYS,
  buildBackupFilename,
  buildBackupPayload,
  buildInsertBatch,
  buildAggregateRollupSql,
  executeReplaceChart,
  insertBackfillBuckets,
  loadExistingBuckets,
  rebuildDependentAggregates,
  writeBackupFile,
  __private: {
    assertOneMinuteRangeIsNotProtected,
    deleteExistingRows,
    getAlignedRange,
    getAffectedAggregateGranularities,
    getReplaceRange,
    getTargetGranularityMinutes,
    rebuildDependentAggregates,
    writeBackupFile,
  },
};
