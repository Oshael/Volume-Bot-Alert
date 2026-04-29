const db = require('../models/db');
const { DEFAULT_OPTIONS } = require('./pumpfun-post-migration-blast-signal');

const DEFAULT_MIGRATION_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_CANDIDATE_LIMIT = 250;
const MAX_CANDIDATE_LIMIT = 500;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function resolveOptions(options = {}) {
  return {
    migrationGraceMs: Math.max(1, Number(options.migrationGraceMs) || DEFAULT_MIGRATION_GRACE_MS),
    maxMigrationAgeMs: Math.max(1, Number(options.maxMigrationAgeMs) || DEFAULT_OPTIONS.maxMigrationAgeMs),
    minHighMcapRecent: Math.max(1, Number(options.minHighMcapRecent) || DEFAULT_OPTIONS.minHighMcapRecent),
    limit: Math.max(1, Math.min(Number(options.limit) || DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT)),
    now: toTimestampOrNull(options.now) || new Date(),
  };
}

function mapCandidateRow(row) {
  return {
    address: String(row.address || '').trim(),
    symbol: row.symbol || '',
    name: row.name || '',
    source: String(row.source || '').trim().toLowerCase(),
    migrationStartedAt: row.migration_started_at || null,
    currentBucketAt: row.current_bucket_at || null,
    volumeBucketCount: toNumberOrNull(row.vol_buckets),
    signalInput: {
      source: String(row.source || '').trim().toLowerCase(),
      migrationAgeMs: toNumberOrNull(row.migration_age_ms),
      firstMcap: toNumberOrNull(row.first_mcap),
      currentMcap: toNumberOrNull(row.current_mcap),
      highMcapRecent: toNumberOrNull(row.high_mcap_recent),
      maxVol5mRecent: toNumberOrNull(row.max_vol_5m_recent),
      p95Vol5mRecent: toNumberOrNull(row.p95_vol_5m_recent),
      timeToHighMcapMs: toNumberOrNull(row.time_to_high_mcap_ms),
      bucketCoverage: toNumberOrNull(row.mcap_buckets),
    },
  };
}

function normalizeOutcomeAlert(alert) {
  const address = String(alert?.address || '').trim();
  const alertTriggeredAt = toTimestampOrNull(alert?.alertTriggeredAt || alert?.alert_triggered_at);
  const alertMcap = toNumberOrNull(alert?.alertMcap ?? alert?.alert_mcap);
  if (!address || !alertTriggeredAt || !alertMcap || alertMcap <= 0) return null;
  return {
    address,
    alert_triggered_at: alertTriggeredAt.toISOString(),
    alert_mcap: alertMcap,
  };
}

function mapOutcomeRow(row) {
  return {
    address: String(row.address || '').trim(),
    maxMcapSinceAlert: toNumberOrNull(row.max_mcap_since_alert),
    maxMcapBucketAt: row.max_mcap_bucket_at || null,
    latestMcapSinceAlert: toNumberOrNull(row.latest_mcap_since_alert),
    latestBucketAt: row.latest_bucket_at || null,
  };
}

async function listPumpfunPostMigrationBlastCandidates(options = {}) {
  const settings = resolveOptions(options);
  const { rows } = await db.query(
    `WITH base_raw AS (
       SELECT
         address,
         symbol,
         name,
         source,
         CASE
           WHEN migration_grace_until IS NOT NULL
             THEN migration_grace_until - ($1::bigint * INTERVAL '1 millisecond')
           ELSE first_seen_at
         END AS migration_started_at
       FROM token_catalog
       WHERE source = 'pumpfun-migrated'
         AND first_seen_at >= $4::timestamptz - (($2::bigint + $1::bigint) * INTERVAL '1 millisecond')
     ),
     base AS (
       SELECT *
       FROM base_raw
       WHERE migration_started_at IS NOT NULL
         AND migration_started_at <= $4::timestamptz
         AND migration_started_at >= $4::timestamptz - ($2::bigint * INTERVAL '1 millisecond')
       ORDER BY migration_started_at DESC
       LIMIT $3::int
     ),
     mcap_window AS (
       SELECT
         b.address,
         b.symbol,
         b.name,
         b.source,
         b.migration_started_at,
         mb.bucket_ts,
         mb.close_mcap,
         mb.high_mcap,
         FIRST_VALUE(mb.close_mcap) OVER (
           PARTITION BY b.address
           ORDER BY mb.bucket_ts ASC
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
         ) AS first_mcap,
         ROW_NUMBER() OVER (
           PARTITION BY b.address
           ORDER BY mb.bucket_ts DESC
         ) AS rn_current
       FROM base b
       JOIN token_market_buckets_1m mb
         ON mb.token_address = b.address
        AND mb.bucket_ts >= b.migration_started_at
        AND mb.bucket_ts <= $4::timestamptz
        AND mb.source IN ('pumpfun-migrated', 'dexscreener')
        AND mb.close_mcap > 0
     ),
     mcap_features AS (
       SELECT
         address,
         MAX(symbol) AS symbol,
         MAX(name) AS name,
         MAX(source) AS source,
         MIN(migration_started_at) AS migration_started_at,
         MAX(first_mcap) AS first_mcap,
         MAX(close_mcap) FILTER (WHERE rn_current = 1) AS current_mcap,
         MAX(bucket_ts) FILTER (WHERE rn_current = 1) AS current_bucket_at,
         MAX(high_mcap) AS high_mcap_recent,
         MIN(bucket_ts) FILTER (WHERE high_mcap >= $5::numeric) AS high_mcap_reached_at,
         COUNT(*) AS mcap_buckets
       FROM mcap_window
       GROUP BY address
     ),
     volume_features AS (
       SELECT
         b.address,
         MAX(vb.close_vol_5m) AS max_vol_5m_recent,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY vb.close_vol_5m::double precision) AS p95_vol_5m_recent,
         COUNT(*) AS vol_buckets
       FROM base b
       JOIN token_market_volume_buckets_1m vb
         ON vb.token_address = b.address
        AND vb.bucket_ts >= b.migration_started_at
        AND vb.bucket_ts <= $4::timestamptz
        AND vb.close_vol_5m IS NOT NULL
       GROUP BY b.address
     )
     SELECT
       mf.address,
       mf.symbol,
       mf.name,
       mf.source,
       mf.migration_started_at,
       EXTRACT(EPOCH FROM ($4::timestamptz - mf.migration_started_at)) * 1000 AS migration_age_ms,
       mf.first_mcap,
       mf.current_mcap,
       mf.current_bucket_at,
       mf.high_mcap_recent,
       EXTRACT(EPOCH FROM (mf.high_mcap_reached_at - mf.migration_started_at)) * 1000 AS time_to_high_mcap_ms,
       mf.mcap_buckets,
       vf.max_vol_5m_recent,
       vf.p95_vol_5m_recent,
       vf.vol_buckets
     FROM mcap_features mf
     LEFT JOIN volume_features vf ON vf.address = mf.address
     ORDER BY mf.migration_started_at DESC`,
    [
      settings.migrationGraceMs,
      settings.maxMigrationAgeMs,
      settings.limit,
      settings.now.toISOString(),
      settings.minHighMcapRecent,
    ]
  );

  return rows.map(mapCandidateRow);
}

async function listPumpfunPostMigrationBlastOutcomesSinceAlert(alerts = [], options = {}) {
  const normalizedAlerts = alerts.map(normalizeOutcomeAlert).filter(Boolean);
  if (normalizedAlerts.length === 0) return [];

  const now = toTimestampOrNull(options.now) || new Date();
  const { rows } = await db.query(
    `WITH alerts AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS a(
         address text,
         alert_triggered_at timestamptz,
         alert_mcap numeric
       )
     )
     SELECT
       a.address,
       MAX(mb.close_mcap) AS max_mcap_since_alert,
       (ARRAY_AGG(mb.bucket_ts ORDER BY mb.close_mcap DESC, mb.bucket_ts ASC))[1] AS max_mcap_bucket_at,
       (ARRAY_AGG(mb.close_mcap ORDER BY mb.bucket_ts DESC))[1] AS latest_mcap_since_alert,
       MAX(mb.bucket_ts) AS latest_bucket_at
     FROM alerts a
     JOIN token_market_buckets_1m mb
       ON mb.token_address = a.address
      AND mb.bucket_ts >= a.alert_triggered_at
      AND mb.bucket_ts <= $2::timestamptz
      AND mb.close_mcap > 0
     GROUP BY a.address`,
    [JSON.stringify(normalizedAlerts), now.toISOString()]
  );

  return rows.map(mapOutcomeRow);
}

module.exports = {
  listPumpfunPostMigrationBlastCandidates,
  listPumpfunPostMigrationBlastOutcomesSinceAlert,
  __private: {
    mapCandidateRow,
    mapOutcomeRow,
    normalizeOutcomeAlert,
    resolveOptions,
  },
};
