#!/usr/bin/env node

const db = require('../models/db');
const config = require('../../config');

const DEFAULT_LIMIT = 40;
const DEFAULT_MIN_MCAP = 30000;

function parseArgs(argv) {
  const options = {
    addresses: [],
    json: false,
    limit: DEFAULT_LIMIT,
    minMcap: DEFAULT_MIN_MCAP,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--address' || arg === '-a') {
      const value = argv[index + 1];
      if (value) {
        options.addresses.push(value);
        index += 1;
      }
    } else if (arg === '--limit') {
      options.limit = normalizePositiveInt(argv[index + 1], DEFAULT_LIMIT, 500);
      index += 1;
    } else if (arg === '--min-mcap') {
      options.minMcap = normalizePositiveInt(argv[index + 1], DEFAULT_MIN_MCAP, 1_000_000_000);
      index += 1;
    }
  }

  options.addresses = [...new Set(options.addresses.map((item) => String(item || '').trim()).filter(Boolean))];
  return options;
}

function normalizePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(Math.trunc(parsed), max));
}

function buildAddressFilter(addresses, startParamIndex) {
  if (!addresses.length) {
    return { sql: '', params: [] };
  }
  return {
    sql: `AND tc.address = ANY($${startParamIndex}::varchar[])`,
    params: [addresses],
  };
}

async function queryRuntimeSummary(options) {
  const addressFilter = buildAddressFilter(options.addresses, 2);
  const { rows } = await db.query(
    `WITH eligible AS (
       SELECT tc.*
       FROM token_catalog tc
       WHERE tc.eligible_for_monitoring = TRUE
         AND COALESCE(tc.last_mcap, 0) >= $1
         ${addressFilter.sql}
     ), latest_volume AS (
       SELECT DISTINCT ON (token_address)
         token_address,
         bucket_ts,
         close_vol_5m
       FROM token_market_volume_buckets_1m
       ORDER BY token_address, bucket_ts DESC
     ), joined AS (
       SELECT
         eligible.*,
         latest_volume.bucket_ts AS latest_volume_bucket_ts
       FROM eligible
       LEFT JOIN latest_volume ON latest_volume.token_address = eligible.address
     )
     SELECT
       COUNT(*)::int AS eligible_count,
       COUNT(*) FILTER (WHERE last_evaluated_at >= NOW() - INTERVAL '30 seconds')::int AS evaluated_30s,
       COUNT(*) FILTER (WHERE last_evaluated_at >= NOW() - INTERVAL '2 minutes')::int AS evaluated_2m,
       COUNT(*) FILTER (WHERE last_evaluated_at < NOW() - INTERVAL '5 minutes' OR last_evaluated_at IS NULL)::int AS eval_stale_5m,
       COUNT(*) FILTER (WHERE latest_volume_bucket_ts >= NOW() - INTERVAL '2 minutes')::int AS volume_bucket_2m,
       COUNT(*) FILTER (WHERE latest_volume_bucket_ts < NOW() - INTERVAL '5 minutes' OR latest_volume_bucket_ts IS NULL)::int AS volume_bucket_stale_5m,
       COUNT(*) FILTER (WHERE source = 'user-manual')::int AS manual_count,
       COUNT(*) FILTER (WHERE source <> 'user-manual' AND COALESCE(last_vol_24h, 0) < 5000)::int AS low_activity_auto_count,
       MIN(last_evaluated_at) AS oldest_eval,
       MAX(last_evaluated_at) AS newest_eval,
       MIN(latest_volume_bucket_ts) AS oldest_volume_bucket,
       MAX(latest_volume_bucket_ts) AS newest_volume_bucket
     FROM joined`,
    [options.minMcap, ...addressFilter.params],
  );
  return rows[0] || {};
}

async function queryDueSummary() {
  const { rows } = await db.query(
    `SELECT
       COALESCE(monitor_priority, 'dormant') AS priority,
       COUNT(*)::int AS due_count,
       ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - next_evaluation_at))))::int AS max_overdue_s
     FROM token_catalog
     WHERE is_active_monitor_candidate = TRUE
       AND next_evaluation_at <= NOW()
     GROUP BY COALESCE(monitor_priority, 'dormant')
     ORDER BY priority`,
  );
  return rows;
}

async function querySuspects(options) {
  const addressFilter = buildAddressFilter(options.addresses, 3);
  const { rows } = await db.query(
    `WITH latest_volume AS (
       SELECT DISTINCT ON (token_address)
         token_address,
         bucket_ts,
         close_vol_5m,
         sample_count,
         source
       FROM token_market_volume_buckets_1m
       ORDER BY token_address, bucket_ts DESC
     ), recent_volume AS (
       SELECT
         token_address,
         COUNT(*) FILTER (WHERE bucket_ts >= NOW() - INTERVAL '15 minutes')::int AS buckets_15m,
         COUNT(DISTINCT close_vol_5m) FILTER (WHERE bucket_ts >= NOW() - INTERVAL '15 minutes')::int AS distinct_vol5m_15m,
         MIN(close_vol_5m) FILTER (WHERE bucket_ts >= NOW() - INTERVAL '15 minutes') AS min_vol5m_15m,
         MAX(close_vol_5m) FILTER (WHERE bucket_ts >= NOW() - INTERVAL '15 minutes') AS max_vol5m_15m
       FROM token_market_volume_buckets_1m
       GROUP BY token_address
     )
     SELECT
       tc.address,
       tc.symbol,
       tc.source,
       tc.monitor_priority,
       ROUND(COALESCE(tc.last_mcap, 0))::bigint AS mcap,
       ROUND(COALESCE(tc.last_vol_5m, 0))::bigint AS catalog_vol5m,
       ROUND(COALESCE(tc.last_vol_24h, 0))::bigint AS catalog_vol24h,
       CASE
         WHEN tc.last_evaluated_at IS NULL THEN NULL
         ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - tc.last_evaluated_at)))::int
       END AS eval_age_s,
       ROUND(EXTRACT(EPOCH FROM (tc.next_evaluation_at - NOW())))::int AS next_due_in_s,
       CASE
         WHEN lv.bucket_ts IS NULL THEN NULL
         ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - lv.bucket_ts)))::int
       END AS volume_bucket_age_s,
       ROUND(COALESCE(lv.close_vol_5m, 0))::bigint AS latest_bucket_vol5m,
       COALESCE(rv.buckets_15m, 0) AS buckets_15m,
       COALESCE(rv.distinct_vol5m_15m, 0) AS distinct_vol5m_15m,
       ROUND(COALESCE(rv.min_vol5m_15m, 0))::bigint AS min_vol5m_15m,
       ROUND(COALESCE(rv.max_vol5m_15m, 0))::bigint AS max_vol5m_15m,
       tc.evaluation_error_count,
       tc.last_evaluation_error,
       tc.suppressed_reason
     FROM token_catalog tc
     LEFT JOIN latest_volume lv ON lv.token_address = tc.address
     LEFT JOIN recent_volume rv ON rv.token_address = tc.address
     WHERE tc.eligible_for_monitoring = TRUE
       AND COALESCE(tc.last_mcap, 0) >= $1
       ${addressFilter.sql}
     ORDER BY
       CASE WHEN lv.bucket_ts IS NULL OR lv.bucket_ts < NOW() - INTERVAL '5 minutes' THEN 0 ELSE 1 END,
       CASE WHEN tc.last_evaluated_at IS NULL OR tc.last_evaluated_at < NOW() - INTERVAL '5 minutes' THEN 0 ELSE 1 END,
       COALESCE(rv.distinct_vol5m_15m, 0) ASC,
       COALESCE(tc.last_mcap, 0) DESC
     LIMIT $2`,
    [options.minMcap, options.limit, ...addressFilter.params],
  );
  return rows;
}

function classifySuspect(row) {
  if (row.eval_age_s == null) return 'never-evaluated';
  if (row.eval_age_s > 300) return 'catalog-worker-stale';
  if (row.volume_bucket_age_s == null) return 'no-volume-bucket';
  if (row.volume_bucket_age_s > 300) return 'volume-bucket-stale';
  if (Number(row.buckets_15m) >= 5 && Number(row.distinct_vol5m_15m) <= 1) return 'dex-vol5m-flat-or-stale';
  if (Number(row.next_due_in_s) > 120) return 'scheduled-slow-path';
  return 'looks-live';
}

function decorateSuspects(rows) {
  return rows.map((row) => ({
    reason: classifySuspect(row),
    ...row,
  }));
}

function printReport(payload) {
  console.log('VOL 5M debug report');
  console.log(JSON.stringify(payload.runtime, null, 2));
  console.log('\nDue backlog by priority');
  console.table(payload.dueSummary);
  console.log('\nTop suspects');
  console.table(payload.suspects);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtime = {
    env: process.env.NODE_ENV || 'development',
    db: {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      ssl: Boolean(config.db.ssl),
    },
    options,
  };
  const [summary, dueSummary, suspectRows] = await Promise.all([
    queryRuntimeSummary(options),
    queryDueSummary(),
    querySuspects(options),
  ]);
  const payload = {
    runtime,
    summary,
    dueSummary,
    suspects: decorateSuspects(suspectRows),
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printReport(payload);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
