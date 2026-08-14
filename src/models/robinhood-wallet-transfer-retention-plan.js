const db = require('./db');
const {
  RAW_RETENTION_DAYS,
  dayBounds,
} = require('./robinhood-token-transfer-persistence');

const CHAIN = 'robinhood';
const MAX_CANDIDATES = 100;

function identifier(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function boundedLimit(value) {
  const parsed = value == null ? 10 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CANDIDATES) {
    throw new Error(`limit must be between 1 and ${MAX_CANDIDATES}`);
  }
  return parsed;
}
function retentionCutoffDay(now = new Date()) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(String(now));
  if (Number.isNaN(date.getTime())) throw new Error('now must be a valid timestamp');
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - RAW_RETENTION_DAYS);
  return date.toISOString().slice(0, 10);
}
function matchesDailyBound(bound, day) {
  if (!bound) return false;
  const match = String(bound).match(
    /FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/
  );
  if (!match) return false;
  const { from, to } = dayBounds(day);
  return new Date(match[1]).getTime() === new Date(from).getTime()
    && new Date(match[2]).getTime() === new Date(to).getTime();
}
function candidate(row) {
  const day = new Date(row.partition_day).toISOString().slice(0, 10);
  const reasons = [
    !row.actual_partition && 'partition_missing',
    row.actual_partition && row.attached !== true && 'partition_not_attached',
    row.attached === true && !matchesDailyBound(row.partition_bound, day) && 'partition_bound_mismatch',
  ].filter(Boolean);
  return Object.freeze({
    partitionDay: day,
    expectedPartition: row.expected_partition,
    actualPartition: row.actual_partition || null,
    partitionBound: row.partition_bound || null,
    watermarkVersion: String(row.watermark_version),
    verifiedAt: new Date(row.verified_at).toISOString(),
    catalogReady: reasons.length === 0,
    blockedReasons: Object.freeze(reasons),
    requiresCanonicalRevalidation: true,
  });
}
function createRobinhoodWalletTransferRetentionPlanner(options = {}) {
  const database = options.database || db;
  async function plan(input = {}) {
    const projectionVersion = identifier(input.projectionVersion, 'projectionVersion');
    const limit = boundedLimit(input.limit);
    const cutoffDay = retentionCutoffDay(input.now);
    const result = await database.query(
      `WITH candidates AS (
         SELECT watermark.partition_day, watermark.verified_at,
                watermark.version AS watermark_version,
                'robinhood_token_transfer_events_'
                  || TO_CHAR(watermark.partition_day, 'YYYY_MM_DD') AS expected_partition
         FROM robinhood_wallet_transfer_compaction_watermarks watermark
         WHERE watermark.chain = $1 AND watermark.projection_version = $2
           AND watermark.lifecycle_state = 'verified' AND watermark.dropped_at IS NULL
           AND watermark.partition_day < $3::date
         ORDER BY watermark.partition_day
         LIMIT $4::integer
       )
       SELECT candidates.*, child.relname AS actual_partition,
              COALESCE(inheritance.inhparent = parent.oid, false) AS attached,
              pg_get_expr(child.relpartbound, child.oid) AS partition_bound
       FROM candidates
       LEFT JOIN pg_namespace namespace ON namespace.nspname = 'public'
       LEFT JOIN pg_class child ON child.relnamespace = namespace.oid
        AND child.relname = candidates.expected_partition
       LEFT JOIN pg_class parent ON parent.relnamespace = namespace.oid
        AND parent.relname = 'robinhood_token_transfer_events'
       LEFT JOIN pg_inherits inheritance ON inheritance.inhrelid = child.oid
        AND inheritance.inhparent = parent.oid
       ORDER BY candidates.partition_day`,
      [CHAIN, projectionVersion, cutoffDay, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const candidates = result.rows.slice(0, limit).map(candidate);
    return Object.freeze({
      retentionDays: RAW_RETENTION_DAYS, cutoffDay, limit, hasMore,
      candidates: Object.freeze(candidates),
      catalogReady: candidates.filter((item) => item.catalogReady).length,
      blocked: candidates.filter((item) => !item.catalogReady).length,
      destructive: false,
    });
  }
  return { plan };
}

module.exports = {
  MAX_CANDIDATES,
  createRobinhoodWalletTransferRetentionPlanner,
  retentionCutoffDay,
};
