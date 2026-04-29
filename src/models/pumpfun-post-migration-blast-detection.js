const db = require('./db');
const { isValidAddress } = require('./user-token');

function normalizeTokenAddress(value) {
  const address = String(value || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }
  return address;
}

function normalizeString(value, maxLength) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function toIsoOrNull(value) {
  const parsed = toTimestampOrNull(value);
  return parsed ? parsed.toISOString() : null;
}

function mapRow(row) {
  if (!row) return null;
  return {
    address: row.token_address || null,
    symbol: row.symbol || null,
    name: row.name || null,
    migrationStartedAt: toIsoOrNull(row.migration_started_at),
    alertTriggeredAt: toIsoOrNull(row.alert_triggered_at),
    alertMcap: toNumberOrNull(row.alert_mcap),
    score: toNumberOrNull(row.score),
    reason: row.reason || null,
    evidenceAtAlert: normalizeJsonObject(row.evidence_at_alert),
    latestMcapSinceAlert: toNumberOrNull(row.latest_mcap_since_alert),
    latestBucketAt: toIsoOrNull(row.latest_bucket_at),
    maxMcapSinceAlert: toNumberOrNull(row.max_mcap_since_alert),
    maxMcapBucketAt: toIsoOrNull(row.max_mcap_bucket_at),
    maxXSinceAlert: toNumberOrNull(row.max_x_since_alert),
    firstMatchedAt: toIsoOrNull(row.first_matched_at),
    lastMatchedAt: toIsoOrNull(row.last_matched_at),
    lastUpdatedAt: toIsoOrNull(row.last_updated_at),
    matchedRuns: toInteger(row.matched_runs, 0),
  };
}

async function upsertDetection(payload = {}, runner = db) {
  const tokenAddress = normalizeTokenAddress(payload.address || payload.tokenAddress);
  const alertTriggeredAt = toTimestampOrNull(payload.alertTriggeredAt);
  if (!alertTriggeredAt) {
    throw new Error('PumpFun post-migration blast alertTriggeredAt is required');
  }

  const { rows } = await runner.query(
    `INSERT INTO pumpfun_post_migration_blast_detections (
       token_address, symbol, name, migration_started_at,
       alert_triggered_at, alert_mcap, score, reason, evidence_at_alert,
       latest_mcap_since_alert, latest_bucket_at,
       max_mcap_since_alert, max_mcap_bucket_at, max_x_since_alert,
       first_matched_at, last_matched_at, last_updated_at, matched_runs
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (token_address) DO UPDATE SET
       symbol = COALESCE(EXCLUDED.symbol, pumpfun_post_migration_blast_detections.symbol),
       name = COALESCE(EXCLUDED.name, pumpfun_post_migration_blast_detections.name),
       migration_started_at = COALESCE(EXCLUDED.migration_started_at, pumpfun_post_migration_blast_detections.migration_started_at),
       alert_triggered_at = EXCLUDED.alert_triggered_at,
       alert_mcap = EXCLUDED.alert_mcap,
       score = EXCLUDED.score,
       reason = EXCLUDED.reason,
       evidence_at_alert = EXCLUDED.evidence_at_alert,
       latest_mcap_since_alert = EXCLUDED.latest_mcap_since_alert,
       latest_bucket_at = EXCLUDED.latest_bucket_at,
       max_mcap_since_alert = EXCLUDED.max_mcap_since_alert,
       max_mcap_bucket_at = EXCLUDED.max_mcap_bucket_at,
       max_x_since_alert = EXCLUDED.max_x_since_alert,
       first_matched_at = LEAST(pumpfun_post_migration_blast_detections.first_matched_at, EXCLUDED.first_matched_at),
       last_matched_at = EXCLUDED.last_matched_at,
       last_updated_at = EXCLUDED.last_updated_at,
       matched_runs = EXCLUDED.matched_runs
     RETURNING *`,
    [
      tokenAddress,
      normalizeString(payload.symbol, 64),
      normalizeString(payload.name, 160),
      toTimestampOrNull(payload.migrationStartedAt),
      alertTriggeredAt,
      toNumberOrNull(payload.alertMcap),
      toNumberOrNull(payload.score),
      normalizeString(payload.reason, 64),
      JSON.stringify(normalizeJsonObject(payload.evidenceAtAlert)),
      toNumberOrNull(payload.latestMcapSinceAlert),
      toTimestampOrNull(payload.latestBucketAt),
      toNumberOrNull(payload.maxMcapSinceAlert),
      toTimestampOrNull(payload.maxMcapBucketAt),
      toNumberOrNull(payload.maxXSinceAlert),
      toTimestampOrNull(payload.firstMatchedAt) || new Date(),
      toTimestampOrNull(payload.lastMatchedAt) || new Date(),
      toTimestampOrNull(payload.lastUpdatedAt) || new Date(),
      Math.max(1, toInteger(payload.matchedRuns, 1)),
    ]
  );

  return mapRow(rows[0] || null);
}

async function listRecentDetections(options = {}, runner = db) {
  const limit = Math.max(1, Math.min(toInteger(options.limit, 100), 500));
  const since = toTimestampOrNull(options.since);
  const params = since ? [since, limit] : [limit];
  const whereSince = since ? 'WHERE alert_triggered_at >= $1' : '';
  const limitParam = since ? '$2' : '$1';

  const { rows } = await runner.query(
    `SELECT *
     FROM pumpfun_post_migration_blast_detections
     ${whereSince}
     ORDER BY alert_triggered_at DESC, token_address ASC
     LIMIT ${limitParam}`,
    params
  );

  return rows.map(mapRow);
}

module.exports = {
  listRecentDetections,
  upsertDetection,
  __private: {
    mapRow,
    normalizeJsonObject,
    normalizeString,
    normalizeTokenAddress,
    toIsoOrNull,
    toNumberOrNull,
    toTimestampOrNull,
  },
};
