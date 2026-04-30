const db = require('../models/db');
const { DEFAULT_OPTIONS } = require('./pumpfun-combo-confirmation-signal');

const DEFAULT_CANDIDATE_LIMIT = 250;
const MAX_CANDIDATE_LIMIT = 500;
const DEFAULT_DETECTION_AGE_MS = 24 * 60 * 60 * 1000;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function resolveOptions(options = {}) {
  return {
    maxDetectionAgeMs: Math.max(60_000, Number(options.maxDetectionAgeMs) || DEFAULT_DETECTION_AGE_MS),
    minBlastAlertMcap: Math.max(1, Number(options.minBlastAlertMcap) || DEFAULT_OPTIONS.minBlastAlertMcap),
    maxBlastAlertMcap: Math.max(1, Number(options.maxBlastAlertMcap) || DEFAULT_OPTIONS.maxBlastAlertMcap),
    limit: Math.max(1, Math.min(Number(options.limit) || DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT)),
    now: toTimestampOrNull(options.now) || new Date(),
  };
}

function mapCandidateRow(row) {
  const blastEvidence = normalizeJsonObject(row.blast_evidence_at_alert);
  const fastEvidence = normalizeJsonObject(row.fast_evidence_at_alert);
  const blastAlertAt = toTimestampOrNull(row.blast_alert_triggered_at);
  const fastAlertAt = toTimestampOrNull(row.fast_alert_triggered_at);
  const fastConfirmationDelayMs = blastAlertAt && fastAlertAt
    ? fastAlertAt.getTime() - blastAlertAt.getTime()
    : null;

  return {
    address: String(row.address || '').trim(),
    symbol: row.symbol || '',
    name: row.name || '',
    migrationStartedAt: row.migration_started_at || null,
    currentBucketAt: row.blast_alert_triggered_at || null,
    blastAlertTriggeredAt: row.blast_alert_triggered_at || null,
    fastAlertTriggeredAt: row.fast_alert_triggered_at || null,
    signalInput: {
      blastAlertMcap: toNumberOrNull(row.blast_alert_mcap),
      blastScore: toNumberOrNull(row.blast_score),
      blastTimeToHighMcapMs: toNumberOrNull(blastEvidence.timeToHighMcapMs),
      blastHighMcapRecent: toNumberOrNull(blastEvidence.highMcapRecent),
      blastStrongestVol5m: toNumberOrNull(blastEvidence.strongestVol5m ?? blastEvidence.maxVol5mRecent),
      hasFastConfirmation: Boolean(row.fast_alert_triggered_at),
      fastConfirmationDelayMs,
      fastAlertMcap: toNumberOrNull(row.fast_alert_mcap),
      fastScore: toNumberOrNull(row.fast_score),
      fastTimeTo2xMs: toNumberOrNull(fastEvidence.timeTo2xMs),
      preBuckets: toNumberOrNull(row.pre_buckets),
      preHighMcap: toNumberOrNull(row.pre_high_mcap),
      maxPreVol5m: toNumberOrNull(row.max_pre_vol_5m),
    },
    sourceEvidence: {
      blast: blastEvidence,
      fast: fastEvidence,
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

async function listPumpfunComboConfirmationCandidates(options = {}) {
  const settings = resolveOptions(options);
  const { rows } = await db.query(
    `WITH base AS (
       SELECT
         b.token_address,
         b.symbol,
         b.name,
         b.migration_started_at,
         b.alert_triggered_at,
         b.alert_mcap,
         b.score,
         b.evidence_at_alert
       FROM pumpfun_post_migration_blast_detections b
       WHERE b.alert_triggered_at >= $1::timestamptz - ($2::bigint * INTERVAL '1 millisecond')
         AND b.alert_triggered_at <= $1::timestamptz
         AND b.alert_mcap >= $3::numeric
         AND b.alert_mcap <= $4::numeric
       ORDER BY b.alert_triggered_at DESC
       LIMIT $5::int
     ),
     pre AS (
       SELECT
         mb.token_address,
         COUNT(*) AS pre_buckets,
         MAX(mb.high_mcap) AS pre_high_mcap,
         MAX(vb.close_vol_5m) AS max_pre_vol_5m
       FROM token_market_buckets_1m mb
       LEFT JOIN token_market_volume_buckets_1m vb
         ON vb.token_address = mb.token_address
        AND vb.bucket_ts = mb.bucket_ts
        AND vb.source = 'pumpfun-pre-migration'
       JOIN base b ON b.token_address = mb.token_address
       WHERE mb.source = 'pumpfun-pre-migration'
       GROUP BY mb.token_address
     )
     SELECT
       b.token_address AS address,
       COALESCE(b.symbol, f.symbol) AS symbol,
       COALESCE(b.name, f.name) AS name,
       COALESCE(b.migration_started_at, f.migration_started_at) AS migration_started_at,
       b.alert_triggered_at AS blast_alert_triggered_at,
       b.alert_mcap AS blast_alert_mcap,
       b.score AS blast_score,
       b.evidence_at_alert AS blast_evidence_at_alert,
       f.alert_triggered_at AS fast_alert_triggered_at,
       f.alert_mcap AS fast_alert_mcap,
       f.score AS fast_score,
       f.evidence_at_alert AS fast_evidence_at_alert,
       pre.pre_buckets,
       pre.pre_high_mcap,
       pre.max_pre_vol_5m
     FROM base b
     LEFT JOIN pumpfun_fast_5x_detections f
       ON f.token_address = b.token_address
      AND f.rule_key = 'pumpfun-fast-5x'
     LEFT JOIN pre ON pre.token_address = b.token_address
     ORDER BY b.alert_triggered_at DESC`,
    [
      settings.now.toISOString(),
      settings.maxDetectionAgeMs,
      settings.minBlastAlertMcap,
      settings.maxBlastAlertMcap,
      settings.limit,
    ]
  );

  return rows.map(mapCandidateRow);
}

async function listPumpfunComboConfirmationOutcomesSinceAlert(alerts = [], options = {}) {
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
  listPumpfunComboConfirmationCandidates,
  listPumpfunComboConfirmationOutcomesSinceAlert,
  __private: {
    mapCandidateRow,
    resolveOptions,
  },
};
