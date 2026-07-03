const path = require('path');
const writer = require('./coingecko-chart-backfill-write');

const BAD_BUCKET_CRITERIA = Object.freeze([
  'missing_mcap_ohlc',
  'non_positive_mcap_ohlc',
  'high_below_body',
  'low_above_body',
  'high_below_low',
]);

function normalizeString(value) {
  return String(value ?? '').trim();
}

function validateOptions(options) {
  if (!options.db?.getClient) throw new Error('db.getClient is required');
  const plan = options.plan;
  const tokenAddress = normalizeString(plan?.token?.address);
  const buckets = Array.isArray(options.buckets) ? options.buckets : [];
  if (!tokenAddress) throw new Error('Plan token address is required');
  if (!plan?.readiness?.canReplace) {
    throw new Error(`Plan is not ready: ${(plan?.readiness?.blockers || []).join(', ')}`);
  }
  if (!buckets.length) throw new Error('No CoinGecko buckets available');
  const granularityMinutes = writer.__private.getTargetGranularityMinutes(plan);
  const range = writer.__private.getReplaceRange(plan);
  writer.__private.assertOneMinuteRangeIsNotProtected(
    range,
    granularityMinutes,
    options.now || new Date()
  );
  return { plan, tokenAddress, buckets, granularityMinutes, range };
}

async function executeFillMissing(options = {}) {
  const context = validateOptions(options);
  const client = await options.db.getClient();
  try {
    await client.query('BEGIN');
    const existingTimestamps = await listExistingBucketTimestamps(client, context);
    const existingSet = new Set(existingTimestamps);
    const missingBuckets = context.buckets.filter(
      (bucket) => !existingSet.has(new Date(bucket.bucketTs).toISOString())
    );
    if (!missingBuckets.length) {
      await client.query('COMMIT');
      return {
        mode: 'fill-missing',
        writes: true,
        tokenAddress: context.tokenAddress,
        granularityMinutes: context.granularityMinutes,
        range: context.range,
        inserted: 0,
        backupPath: null,
        rebuiltAggregates: {},
      };
    }
    const backupPath = await createSelectiveBackup(client, context, options, 'fill-missing');
    const inserted = await writer.insertBackfillBuckets(client, context.buckets, {
      batchSize: options.batchSize,
      granularityMinutes: context.granularityMinutes,
      conflictMode: 'ignore',
    });
    const rebuiltAggregates = inserted > 0
      ? await writer.rebuildDependentAggregates(
        client,
        context.tokenAddress,
        context.range,
        context.granularityMinutes
      )
      : {};
    await client.query('COMMIT');
    return {
      mode: 'fill-missing',
      writes: true,
      tokenAddress: context.tokenAddress,
      granularityMinutes: context.granularityMinutes,
      range: context.range,
      inserted,
      backupPath,
      rebuiltAggregates,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function buildBadBucketWhereSql(granularityMinutes) {
  const granularityFilter = granularityMinutes === 1 ? '' : '\n       AND granularity_minutes = $4::int';
  return `token_address = $1
       AND bucket_ts >= $2::timestamptz
       AND bucket_ts <= $3::timestamptz${granularityFilter}
       AND (
         open_mcap IS NULL OR high_mcap IS NULL OR low_mcap IS NULL OR close_mcap IS NULL
         OR open_mcap <= 0 OR high_mcap <= 0 OR low_mcap <= 0 OR close_mcap <= 0
         OR high_mcap < GREATEST(open_mcap, close_mcap)
         OR low_mcap > LEAST(open_mcap, close_mcap)
         OR high_mcap < low_mcap
       )`;
}

async function listBadBucketTimestamps(client, context) {
  const table = context.granularityMinutes === 1
    ? 'token_market_buckets_1m'
    : 'token_market_buckets_agg';
  const params = [context.tokenAddress, context.range.from, context.range.to];
  if (context.granularityMinutes !== 1) params.push(context.granularityMinutes);
  const result = await client.query(
    `SELECT bucket_ts
     FROM ${table}
     WHERE ${buildBadBucketWhereSql(context.granularityMinutes)}
     ORDER BY bucket_ts ASC`,
    params
  );
  return (result.rows || [])
    .map((row) => new Date(row.bucket_ts).toISOString());
}

async function listExistingBucketTimestamps(client, context) {
  const table = context.granularityMinutes === 1
    ? 'token_market_buckets_1m'
    : 'token_market_buckets_agg';
  const granularityFilter = context.granularityMinutes === 1
    ? ''
    : '\n       AND granularity_minutes = $4::int';
  const params = [context.tokenAddress, context.range.from, context.range.to];
  if (context.granularityMinutes !== 1) params.push(context.granularityMinutes);
  const result = await client.query(
    `SELECT bucket_ts
     FROM ${table}
     WHERE token_address = $1
       AND bucket_ts >= $2::timestamptz
       AND bucket_ts <= $3::timestamptz${granularityFilter}`,
    params
  );
  return (result.rows || []).map((row) => new Date(row.bucket_ts).toISOString());
}

async function inspectSelectiveWrite(options = {}) {
  const context = validateOptions(options);
  const client = await options.db.getClient();
  try {
    const existingTimestamps = options.mode === 'replace-bad-buckets'
      ? await listBadBucketTimestamps(client, context)
      : await listExistingBucketTimestamps(client, context);
    const existingSet = new Set(existingTimestamps);
    const matched = context.buckets.filter((bucket) => {
      const timestamp = new Date(bucket.bucketTs).toISOString();
      return options.mode === 'replace-bad-buckets'
        ? existingSet.has(timestamp)
        : !existingSet.has(timestamp);
    });
    return {
      mode: options.mode,
      candidateCandles: context.buckets.length,
      matchingExistingRows: existingTimestamps.length,
      wouldWrite: matched.length,
      criteria: options.mode === 'replace-bad-buckets' ? BAD_BUCKET_CRITERIA : ['bucket_missing'],
    };
  } finally {
    client.release();
  }
}

async function createSelectiveBackup(client, context, options, operationMode) {
  const existingBuckets = await writer.loadExistingBuckets(
    client,
    context.tokenAddress,
    context.range,
    context.granularityMinutes
  );
  const generatedAt = new Date().toISOString();
  const payload = writer.buildBackupPayload({
    plan: context.plan,
    existingBuckets,
    generatedAt,
  });
  payload.operationMode = operationMode;
  return writer.writeBackupFile({
    fsImpl: options.fsImpl,
    backupDir: options.backupDir || path.resolve(process.cwd(), 'data/coingecko/backups'),
    tokenAddress: context.tokenAddress,
    payload,
    now: new Date(generatedAt),
  });
}

async function executeReplaceBadBuckets(options = {}) {
  const context = validateOptions(options);
  const client = await options.db.getClient();
  try {
    await client.query('BEGIN');
    const badTimestamps = await listBadBucketTimestamps(client, context);
    const badSet = new Set(badTimestamps);
    const replacements = context.buckets.filter((bucket) => badSet.has(new Date(bucket.bucketTs).toISOString()));
    if (!replacements.length) {
      await client.query('COMMIT');
      return {
        mode: 'replace-bad-buckets',
        writes: true,
        matchedBadBuckets: badTimestamps.length,
        replaced: 0,
        backupPath: null,
        rebuiltAggregates: {},
        criteria: BAD_BUCKET_CRITERIA,
      };
    }

    const backupPath = await createSelectiveBackup(
      client,
      context,
      options,
      'replace-bad-buckets'
    );
    const replaced = await writer.insertBackfillBuckets(client, replacements, {
      batchSize: options.batchSize,
      granularityMinutes: context.granularityMinutes,
    });
    const rebuiltAggregates = await writer.rebuildDependentAggregates(
      client,
      context.tokenAddress,
      context.range,
      context.granularityMinutes
    );
    await client.query('COMMIT');
    return {
      mode: 'replace-bad-buckets',
      writes: true,
      matchedBadBuckets: badTimestamps.length,
      replaced,
      backupPath,
      rebuiltAggregates,
      criteria: BAD_BUCKET_CRITERIA,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  BAD_BUCKET_CRITERIA,
  executeFillMissing,
  executeReplaceBadBuckets,
  inspectSelectiveWrite,
  __private: {
    buildBadBucketWhereSql,
    listBadBucketTimestamps,
    listExistingBucketTimestamps,
    validateOptions,
  },
};
