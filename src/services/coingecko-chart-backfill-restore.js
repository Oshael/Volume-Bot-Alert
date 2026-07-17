const fs = require('fs/promises');
const writer = require('./coingecko-chart-backfill-write');

const SUPPORTED_GRANULARITIES = new Set([1, 5, 15, 30, 60, 240, 1440]);

function normalizeString(value) {
  return String(value ?? '').trim();
}

function parseTimestamp(value, field) {
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) throw new Error(`Invalid backup ${field}`);
  return new Date(timestampMs).toISOString();
}

function inferGranularity(payload) {
  const explicit = Number(payload?.granularityMinutes);
  if ([1, 5].includes(explicit)) return explicit;
  throw new Error('Backup granularityMinutes must be explicitly 1 or 5');
}

function validateRows(rows, tokenAddress, type) {
  if (!Array.isArray(rows)) throw new Error(`Backup ${type} rows must be an array`);
  for (const row of rows) {
    if (normalizeString(row?.token_address) !== tokenAddress) {
      throw new Error(`Backup ${type} row token does not match ${tokenAddress}`);
    }
    parseTimestamp(row.bucket_ts, `${type} bucket timestamp`);
    if (type === 'aggregate' && !SUPPORTED_GRANULARITIES.has(Number(row.granularity_minutes))) {
      throw new Error(`Unsupported backup aggregate granularity: ${row.granularity_minutes}`);
    }
  }
}

function validateBackupPayload(payload, expectedTokenAddress = '') {
  if (!payload || payload.operation !== 'coingecko_replace_chart_backup') {
    throw new Error('Unsupported or invalid CoinGecko backup');
  }
  const tokenAddress = normalizeString(payload.token?.address);
  if (!tokenAddress) throw new Error('Backup token address is required');
  if (expectedTokenAddress && normalizeString(expectedTokenAddress) !== tokenAddress) {
    throw new Error('Backup token does not match --token');
  }
  const range = {
    from: parseTimestamp(payload.range?.firstBucketAt, 'range start'),
    to: parseTimestamp(payload.range?.latestBucketAt, 'range end'),
  };
  if (Date.parse(range.from) > Date.parse(range.to)) throw new Error('Backup range is reversed');

  const baseRows = payload.tokenMarketBuckets1m;
  const aggregateRows = payload.tokenMarketBucketsAgg;
  validateRows(baseRows, tokenAddress, 'base');
  validateRows(aggregateRows, tokenAddress, 'aggregate');
  if (Number(payload.counts?.tokenMarketBuckets1m) !== baseRows.length
    || Number(payload.counts?.tokenMarketBucketsAgg) !== aggregateRows.length) {
    throw new Error('Backup row counts do not match payload contents');
  }

  return {
    payload,
    tokenAddress,
    range,
    granularityMinutes: inferGranularity(payload),
    baseRows,
    aggregateRows,
  };
}

async function loadBackupFile(backupPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const raw = await fsImpl.readFile(backupPath, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    throw new Error('Backup file is not valid JSON');
  }
  return validateBackupPayload(payload, options.expectedTokenAddress);
}

function toWriterBucket(row, granularityMinutes) {
  return {
    tokenAddress: row.token_address,
    bucketTs: row.bucket_ts,
    pairAddress: row.pair_address,
    granularityMinutes,
    openMcap: row.open_mcap,
    highMcap: row.high_mcap,
    lowMcap: row.low_mcap,
    closeMcap: row.close_mcap,
    openPrice: row.open_price,
    highPrice: row.high_price,
    lowPrice: row.low_price,
    closePrice: row.close_price,
    sampleCount: row.sample_count,
    source: row.source,
  };
}

async function deleteChangedScope(client, backup) {
  const deleted = { tokenMarketBuckets1m: 0, tokenMarketBucketsAgg: 0 };
  if (backup.granularityMinutes === 1) {
    const result = await client.query(
      `DELETE FROM token_market_buckets_1m
       WHERE chain = 'solana'
         AND token_address = $1
         AND bucket_ts >= $2::timestamptz
         AND bucket_ts <= $3::timestamptz`,
      [backup.tokenAddress, backup.range.from, backup.range.to]
    );
    deleted.tokenMarketBuckets1m = result.rowCount || 0;
  }

  const granularities = [5, 15, 30, 60, 240, 1440]
    .filter((granularity) => granularity >= backup.granularityMinutes);
  for (const granularity of granularities) {
    const range = granularity === backup.granularityMinutes
      ? { from: backup.range.from, toExclusive: new Date(Date.parse(backup.range.to) + 1).toISOString() }
      : writer.__private.getAlignedRange(backup.range, granularity);
    const result = await client.query(
      `DELETE FROM token_market_buckets_agg
       WHERE chain = 'solana'
         AND token_address = $1
         AND granularity_minutes = $2::int
         AND bucket_ts >= $3::timestamptz
         AND bucket_ts < $4::timestamptz`,
      [backup.tokenAddress, granularity, range.from, range.toExclusive]
    );
    deleted.tokenMarketBucketsAgg += result.rowCount || 0;
  }
  return deleted;
}

async function restoreRows(client, backup, options = {}) {
  let restoredBaseRows = 0;
  if (backup.baseRows.length > 0) {
    restoredBaseRows = await writer.insertBackfillBuckets(
      client,
      backup.baseRows.map((row) => toWriterBucket(row, 1)),
      { batchSize: options.batchSize, granularityMinutes: 1 }
    );
  }
  let restoredAggregateRows = 0;
  const byGranularity = new Map();
  for (const row of backup.aggregateRows) {
    const granularity = Number(row.granularity_minutes);
    if (!byGranularity.has(granularity)) byGranularity.set(granularity, []);
    byGranularity.get(granularity).push(toWriterBucket(row, granularity));
  }
  for (const [granularityMinutes, buckets] of byGranularity) {
    restoredAggregateRows += await writer.insertBackfillBuckets(client, buckets, {
      batchSize: options.batchSize,
      granularityMinutes,
    });
  }
  return { tokenMarketBuckets1m: restoredBaseRows, tokenMarketBucketsAgg: restoredAggregateRows };
}

async function executeRestore(options = {}) {
  if (!options.db?.getClient) throw new Error('db.getClient is required');
  const backup = options.backup?.payload
    ? options.backup
    : validateBackupPayload(options.backup, options.expectedTokenAddress);
  const client = await options.db.getClient();
  try {
    await client.query('BEGIN');
    const deleted = await deleteChangedScope(client, backup);
    const restored = await restoreRows(client, backup, options);
    await client.query('COMMIT');
    return {
      mode: 'restore-backup',
      writes: true,
      tokenAddress: backup.tokenAddress,
      granularityMinutes: backup.granularityMinutes,
      range: backup.range,
      deleted,
      restored,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  executeRestore,
  loadBackupFile,
  validateBackupPayload,
  __private: {
    deleteChangedScope,
    inferGranularity,
    restoreRows,
    toWriterBucket,
  },
};
