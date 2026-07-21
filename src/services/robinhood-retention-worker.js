const db = require('../models/db');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_BATCH_LIMIT = 2000;
const DEFAULT_MAX_BATCHES = 5;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10 * 1000;
const DEFAULT_HOURLY_RETENTION_DAYS = 14;

let timer = null;
let running = false;
let activeRunPromise = null;
let status = {
  running: false,
  inFlight: false,
  enabled: true,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastExaminedProcessedLogs: 0,
  lastDeletedProcessedLogs: 0,
  lastProtectedProcessedLogs: 0,
  lastDeletedObservations: 0,
  lastDeletedMinuteBuckets: 0,
  lastProtectedMinuteBuckets: 0,
  lastDeletedHourlyBuckets: 0,
  lastProtectedHourlyBuckets: 0,
  totalDeletedProcessedLogs: 0,
  totalDeletedObservations: 0,
  totalDeletedMinuteBuckets: 0,
  totalDeletedHourlyBuckets: 0,
  totalErrors: 0,
  lastError: null,
};

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled !== false,
    intervalMs: boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 10_000, 60 * 60 * 1000),
    batchLimit: boundedInteger(options.batchLimit, DEFAULT_BATCH_LIMIT, 100, 10_000),
    maxBatches: boundedInteger(options.maxBatches, DEFAULT_MAX_BATCHES, 1, 50),
    hourlyRetentionDays: boundedInteger(
      options.hourlyRetentionDays,
      DEFAULT_HOURLY_RETENTION_DAYS,
      1,
      3650
    ),
    statementTimeoutMs: boundedInteger(
      options.statementTimeoutMs,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      1000,
      60 * 1000
    ),
  };
}

function queryWithTimeout(database, sql, params, timeoutMs) {
  if (typeof database.queryWithStatementTimeout === 'function') {
    return database.queryWithStatementTimeout(sql, params, timeoutMs);
  }
  return database.query(sql, params);
}

async function deleteExpiredProcessedLogs(database, options) {
  const result = await queryWithTimeout(
    database,
    `WITH expired AS MATERIALIZED (
       SELECT processed.chain, processed.transaction_hash, processed.log_index
       FROM robinhood_processed_logs processed
       WHERE processed.expires_at <= NOW()
       ORDER BY processed.expires_at ASC
       LIMIT $1::int
       FOR UPDATE OF processed SKIP LOCKED
     ),
     candidates AS (
       SELECT expired.chain, expired.transaction_hash, expired.log_index
       FROM expired
       LEFT JOIN robinhood_market_observations observation
         ON observation.chain = expired.chain
        AND observation.transaction_hash = expired.transaction_hash
        AND observation.log_index = expired.log_index
       WHERE observation.status IS NULL
          OR observation.status = 'rejected'
          OR (
            observation.status = 'accepted'
            AND EXISTS (
              SELECT 1
              FROM robinhood_market_buckets_1m minute
              WHERE minute.chain = observation.chain
                AND minute.protocol = observation.protocol
                AND minute.market_key = observation.market_key
                AND minute.token_address = observation.token_address
                AND minute.quote_address = observation.quote_address
                AND minute.bucket_ts = date_trunc('minute', observation.observed_at)
                AND (minute.first_block_number, minute.first_log_index)
                  <= (observation.block_number, observation.log_index)
                AND (minute.last_block_number, minute.last_log_index)
                  >= (observation.block_number, observation.log_index)
            )
          )
     ),
     observation_stats AS (
       SELECT COUNT(*)::int AS observations
       FROM robinhood_market_observations observation
       INNER JOIN candidates
         ON candidates.chain = observation.chain
        AND candidates.transaction_hash = observation.transaction_hash
        AND candidates.log_index = observation.log_index
     ),
     deleted AS (
       DELETE FROM robinhood_processed_logs processed
       USING candidates
       WHERE processed.chain = candidates.chain
         AND processed.transaction_hash = candidates.transaction_hash
         AND processed.log_index = candidates.log_index
       RETURNING 1
     )
     SELECT
       (SELECT COUNT(*)::int FROM expired) AS examined_logs,
       (SELECT COUNT(*)::int FROM deleted) AS processed_logs,
       (SELECT observations FROM observation_stats) AS observations`,
    [options.batchLimit],
    options.statementTimeoutMs
  );
  const examined = Number(result.rows[0]?.examined_logs || 0);
  const processedLogs = Number(result.rows[0]?.processed_logs || 0);
  return {
    examined,
    protected: Math.max(0, examined - processedLogs),
    processedLogs,
    observations: Number(result.rows[0]?.observations || 0),
  };
}

async function deleteExpiredMinuteBuckets(database, options) {
  const result = await queryWithTimeout(
    database,
    `WITH expired AS MATERIALIZED (
       SELECT
         minute.chain, minute.protocol, minute.market_key, minute.token_address, minute.bucket_ts,
         minute.first_block_number, minute.last_block_number, minute.updated_at
       FROM robinhood_market_buckets_1m minute
       WHERE minute.expires_at <= NOW()
       ORDER BY minute.expires_at ASC
       LIMIT $1::int
       FOR UPDATE OF minute SKIP LOCKED
     ),
     candidates AS (
       SELECT expired.chain, expired.protocol, expired.market_key, expired.bucket_ts
       FROM expired
       WHERE EXISTS (
         SELECT 1
         FROM robinhood_market_buckets_1h hourly
         WHERE hourly.chain = expired.chain
           AND hourly.protocol = expired.protocol
           AND hourly.market_key = expired.market_key
           AND hourly.bucket_ts =
             date_trunc('hour', expired.bucket_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           AND hourly.first_block_number <= expired.first_block_number
           AND hourly.last_block_number >= expired.last_block_number
           AND hourly.updated_at >= expired.updated_at
       )
         AND NOT EXISTS (
           SELECT 1
           FROM (VALUES (5), (15), (30)) required(granularity_minutes)
           WHERE NOT EXISTS (
             SELECT 1
             FROM robinhood_market_buckets_agg aggregate
             WHERE aggregate.chain = expired.chain
               AND aggregate.token_address = expired.token_address
               AND aggregate.granularity_minutes = required.granularity_minutes
               AND aggregate.bucket_ts = to_timestamp(
                 FLOOR(EXTRACT(EPOCH FROM expired.bucket_ts)
                   / (required.granularity_minutes * 60))
                 * (required.granularity_minutes * 60)
               )
               AND aggregate.first_block_number <= expired.first_block_number
               AND aggregate.last_block_number >= expired.last_block_number
               AND aggregate.updated_at >= expired.updated_at
           )
         )
     ),
     deleted AS (
       DELETE FROM robinhood_market_buckets_1m minute
       USING candidates
       WHERE minute.chain = candidates.chain
         AND minute.protocol = candidates.protocol
         AND minute.market_key = candidates.market_key
         AND minute.bucket_ts = candidates.bucket_ts
       RETURNING 1
     )
     SELECT
       (SELECT COUNT(*)::int FROM expired) AS examined_buckets,
       (SELECT COUNT(*)::int FROM deleted) AS minute_buckets`,
    [options.batchLimit],
    options.statementTimeoutMs
  );
  const examined = Number(result.rows[0]?.examined_buckets || 0);
  const deleted = Number(result.rows[0]?.minute_buckets || 0);
  return {
    deleted,
    examined,
    protected: Math.max(0, examined - deleted),
  };
}

async function deleteCoveredHourlyBuckets(database, options) {
  const result = await queryWithTimeout(
    database,
    `WITH expired AS MATERIALIZED (
       SELECT
         hourly.chain, hourly.protocol, hourly.market_key, hourly.token_address,
         hourly.bucket_ts, hourly.first_block_number, hourly.last_block_number,
         hourly.updated_at
       FROM robinhood_market_buckets_1h hourly
       WHERE hourly.bucket_ts < NOW() - ($2::int * INTERVAL '1 day')
       ORDER BY hourly.bucket_ts ASC
       LIMIT $1::int
       FOR UPDATE OF hourly SKIP LOCKED
     ),
     candidates AS (
       SELECT expired.chain, expired.protocol, expired.market_key, expired.bucket_ts
       FROM expired
       WHERE NOT EXISTS (
         SELECT 1
         FROM robinhood_market_buckets_1m minute
         WHERE minute.chain = expired.chain
           AND minute.protocol = expired.protocol
           AND minute.market_key = expired.market_key
           AND minute.bucket_ts >= expired.bucket_ts
           AND minute.bucket_ts < expired.bucket_ts + INTERVAL '1 hour'
       )
         AND NOT EXISTS (
           SELECT 1
           FROM (VALUES (60), (240), (1440)) required(granularity_minutes)
           WHERE NOT EXISTS (
             SELECT 1
             FROM robinhood_market_buckets_agg aggregate
             WHERE aggregate.chain = expired.chain
               AND aggregate.token_address = expired.token_address
               AND aggregate.granularity_minutes = required.granularity_minutes
               AND aggregate.bucket_ts = to_timestamp(
                 FLOOR(EXTRACT(EPOCH FROM expired.bucket_ts)
                   / (required.granularity_minutes * 60))
                 * (required.granularity_minutes * 60)
               )
               AND aggregate.first_block_number <= expired.first_block_number
               AND aggregate.last_block_number >= expired.last_block_number
               AND aggregate.updated_at >= expired.updated_at
           )
         )
     ),
     deleted AS (
       DELETE FROM robinhood_market_buckets_1h hourly
       USING candidates
       WHERE hourly.chain = candidates.chain
         AND hourly.protocol = candidates.protocol
         AND hourly.market_key = candidates.market_key
         AND hourly.bucket_ts = candidates.bucket_ts
       RETURNING 1
     )
     SELECT
       (SELECT COUNT(*)::int FROM expired) AS examined_buckets,
       (SELECT COUNT(*)::int FROM deleted) AS hourly_buckets`,
    [options.batchLimit, options.hourlyRetentionDays],
    options.statementTimeoutMs
  );
  const examined = Number(result.rows[0]?.examined_buckets || 0);
  const deleted = Number(result.rows[0]?.hourly_buckets || 0);
  return {
    deleted,
    examined,
    protected: Math.max(0, examined - deleted),
  };
}

function emptySummary() {
  return {
    batches: 0,
    examinedProcessedLogs: 0,
    processedLogs: 0,
    protectedProcessedLogs: 0,
    observations: 0,
    minuteBuckets: 0,
    protectedMinuteBuckets: 0,
    hourlyBuckets: 0,
    protectedHourlyBuckets: 0,
  };
}

async function runCleanupBatches(database, options) {
  const summary = emptySummary();
  for (let index = 0; index < options.maxBatches; index += 1) {
    const raw = await deleteExpiredProcessedLogs(database, options);
    summary.batches += 1;
    summary.examinedProcessedLogs += raw.examined;
    summary.processedLogs += raw.processedLogs;
    summary.protectedProcessedLogs += raw.protected;
    summary.observations += raw.observations;
    if (raw.protected > 0) break;

    const minute = await deleteExpiredMinuteBuckets(database, options);
    summary.minuteBuckets += minute.deleted;
    summary.protectedMinuteBuckets += minute.protected;
    if (minute.protected > 0) break;

    const hourly = await deleteCoveredHourlyBuckets(database, options);
    summary.hourlyBuckets += hourly.deleted;
    summary.protectedHourlyBuckets += hourly.protected;
    if (hourly.protected > 0) break;
    if (
      raw.examined < options.batchLimit
      && minute.examined < options.batchLimit
      && hourly.examined < options.batchLimit
    ) break;
  }
  return summary;
}

async function runOnce(options = {}, meta = {}, deps = {}) {
  const normalized = normalizeOptions(options);
  if (!normalized.enabled) return emptySummary();
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();
  if (activeRunPromise) {
    if (ifRunning === 'join') return activeRunPromise;
    throw new Error('Robinhood retention worker already has an active run');
  }

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    status.inFlight = true;
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastError = null;
    try {
      const summary = await runCleanupBatches(deps.database || db, normalized);
      status.lastExaminedProcessedLogs = summary.examinedProcessedLogs;
      status.lastDeletedProcessedLogs = summary.processedLogs;
      status.lastProtectedProcessedLogs = summary.protectedProcessedLogs;
      status.lastDeletedObservations = summary.observations;
      status.lastDeletedMinuteBuckets = summary.minuteBuckets;
      status.lastProtectedMinuteBuckets = summary.protectedMinuteBuckets;
      status.lastDeletedHourlyBuckets = summary.hourlyBuckets;
      status.lastProtectedHourlyBuckets = summary.protectedHourlyBuckets;
      status.totalDeletedProcessedLogs += summary.processedLogs;
      status.totalDeletedObservations += summary.observations;
      status.totalDeletedMinuteBuckets += summary.minuteBuckets;
      status.totalDeletedHourlyBuckets += summary.hourlyBuckets;
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      return summary;
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = String(error?.message || error).slice(0, 1000);
      throw error;
    } finally {
      status.inFlight = false;
      activeRunPromise = null;
    }
  })();
  return activeRunPromise;
}

function schedule(options, delayMs) {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      const summary = await runOnce(options, { ifRunning: 'join' });
      if (summary.examinedProcessedLogs || summary.minuteBuckets || summary.hourlyBuckets) {
        console.log(
          '[RobinhoodRetentionWorker]',
          `logs=${summary.processedLogs}/${summary.examinedProcessedLogs}`,
          `protectedLogs=${summary.protectedProcessedLogs}`,
          `observations=${summary.observations}`,
          `minuteBuckets=${summary.minuteBuckets}`,
          `protectedMinuteBuckets=${summary.protectedMinuteBuckets}`,
          `hourlyBuckets=${summary.hourlyBuckets}`,
          `protectedHourlyBuckets=${summary.protectedHourlyBuckets}`,
          `batches=${summary.batches}`
        );
      }
    } catch (error) {
      console.error('[RobinhoodRetentionWorker] Cleanup failed:', error.message);
    } finally {
      schedule(options, options.intervalMs);
    }
  }, delayMs);
}

function start(options = {}) {
  if (running) return;
  const normalized = normalizeOptions(options);
  running = true;
  status.running = true;
  status.enabled = normalized.enabled;
  schedule(normalized, 0);
}

function stop() {
  running = false;
  status.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function getStatus() {
  return { ...status };
}

module.exports = {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_HOURLY_RETENTION_DAYS,
  DEFAULT_INTERVAL_MS,
  getStatus,
  runOnce,
  start,
  stop,
  __private: {
    deleteCoveredHourlyBuckets,
    deleteExpiredMinuteBuckets,
    deleteExpiredProcessedLogs,
    normalizeOptions,
  },
};
