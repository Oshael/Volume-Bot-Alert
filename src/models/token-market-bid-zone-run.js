const db = require('./db');
const { isValidAddress } = require('./user-token');

const DEFAULT_REQUESTED_HOURS = 48;
const DEFAULT_MIN_MCAP = 90_000;
const DEFAULT_MIN_VOL_1H = 1_000;
const DEFAULT_MIN_VOL_24H = 10_000;
const DEFAULT_RETENTION_MS = 3 * 60 * 60 * 1000;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIntegerOrZero(value) {
  const num = Number.parseInt(value, 10);
  return Number.isInteger(num) ? num : 0;
}

function normalizeRunFilters(filters = {}) {
  return {
    requestedHours: Math.max(1, Math.min(Number(filters.requestedHours) || DEFAULT_REQUESTED_HOURS, 48)),
    minMcap: Math.max(DEFAULT_MIN_MCAP, Number(filters.minMcap) || DEFAULT_MIN_MCAP),
    minVol1h: Math.max(0, Number(filters.minVol1h) || DEFAULT_MIN_VOL_1H),
    minVol24h: Math.max(0, Number(filters.minVol24h) || DEFAULT_MIN_VOL_24H),
  };
}

async function insertBidZoneResult(client, runId, candidate = {}, rank = 1) {
  const address = String(candidate.address || '').trim();
  if (!isValidAddress(address)) {
    return;
  }

  await client.query(
    `INSERT INTO bid_zone_results (
       run_id,
       token_address,
       rank,
       symbol,
       name,
       score,
       mcap,
       catalog_mcap,
       window_mcap,
       volume_1h,
       volume_6h,
       volume_24h,
       support_level_mcap,
       resistance_level_mcap,
       robust_range_pct,
       recent_range_pct,
       close_drift_pct,
       support_distance_pct,
       resistance_distance_pct,
       support_touch_clusters,
       coverage_ratio,
       bucket_count,
       sample_count,
       expected_bucket_count,
       age_hours,
       window_hours_used,
       minimum_window_hours,
       liquidity_penalty,
       volume_1h_penalty,
       monitor_priority,
       first_bucket_at,
       last_bucket_at,
       diagnostics
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23, $24, $25, $26, $27,
       $28, $29, $30, $31, $32, $33::jsonb
     )`,
    [
      runId,
      address,
      rank,
      String(candidate.symbol || '').trim() || null,
      String(candidate.name || '').trim() || null,
      toNumberOrNull(candidate.score),
      toNumberOrNull(candidate.mcap),
      toNumberOrNull(candidate.catalogMcap),
      toNumberOrNull(candidate.windowMcap),
      toNumberOrNull(candidate.volume1h),
      toNumberOrNull(candidate.volume6h),
      toNumberOrNull(candidate.volume24h),
      toNumberOrNull(candidate.supportLevelMcap),
      toNumberOrNull(candidate.resistanceLevelMcap),
      toNumberOrNull(candidate.robustRangePct),
      toNumberOrNull(candidate.recentRangePct),
      toNumberOrNull(candidate.closeDriftPct),
      toNumberOrNull(candidate.supportDistancePct),
      toNumberOrNull(candidate.resistanceDistancePct),
      toIntegerOrZero(candidate.supportTouchClusters),
      toNumberOrNull(candidate.coverageRatio),
      toIntegerOrZero(candidate.bucketCount),
      toIntegerOrZero(candidate.sampleCount),
      toIntegerOrZero(candidate.expectedBucketCount),
      toNumberOrNull(candidate.ageHours),
      toIntegerOrZero(candidate.windowHoursUsed),
      toIntegerOrZero(candidate.minimumWindowHours),
      toNumberOrNull(candidate.liquidityPenalty),
      toNumberOrNull(candidate.volume1hPenalty),
      String(candidate.monitorPriority || '').trim() || null,
      candidate.firstBucketAt || null,
      candidate.lastBucketAt || null,
      JSON.stringify(candidate.reasons || {}),
    ]
  );
}

async function startRun(options = {}) {
  const normalized = normalizeRunFilters(options);
  const notes = String(options.notes || '').trim() || null;
  const triggeredBy = String(options.triggeredBy || 'worker').trim().toLowerCase() || 'worker';

  const { rows } = await db.query(
    `INSERT INTO bid_zone_runs (
       status,
       requested_hours,
       min_mcap,
       min_vol_1h,
       min_vol_24h,
       notes,
       triggered_by
     )
     VALUES ('running', $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      normalized.requestedHours,
      normalized.minMcap,
      normalized.minVol1h,
      normalized.minVol24h,
      notes,
      triggeredBy,
    ]
  );

  return rows[0] || null;
}

async function failRun(runId, errorMessage) {
  const id = Number.parseInt(runId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid bid-zone run ID');
  }

  const { rows } = await db.query(
    `UPDATE bid_zone_runs
     SET status = 'failed',
         completed_at = NOW(),
         error_message = $2
     WHERE id = $1
     RETURNING *`,
    [id, String(errorMessage || '').trim() || 'unknown_error']
  );

  return rows[0] || null;
}

async function completeRun(runId, payload = {}) {
  const id = Number.parseInt(runId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid bid-zone run ID');
  }

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidateCount = Math.max(0, Number(payload.candidateCount) || candidates.length);
  const resultCount = candidates.length;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE bid_zone_runs
       SET status = 'completed',
           completed_at = NOW(),
           candidate_count = $2,
           result_count = $3,
           error_message = NULL
       WHERE id = $1`,
      [id, candidateCount, resultCount]
    );

    for (let index = 0; index < candidates.length; index += 1) {
      await insertBidZoneResult(client, id, candidates[index], index + 1);
    }

    const { rows } = await client.query(
      'SELECT * FROM bid_zone_runs WHERE id = $1 LIMIT 1',
      [id]
    );

    await client.query('COMMIT');
    return rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getLatestCompletedRun(filters = {}) {
  const normalized = normalizeRunFilters(filters);
  const { rows } = await db.query(
    `SELECT *
     FROM bid_zone_runs
     WHERE status = 'completed'
       AND requested_hours = $1
       AND min_mcap = $2
       AND min_vol_1h = $3
       AND min_vol_24h = $4
     ORDER BY completed_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [
      normalized.requestedHours,
      normalized.minMcap,
      normalized.minVol1h,
      normalized.minVol24h,
    ]
  );

  return rows[0] || null;
}

async function listResultsByRunId(runId, options = {}) {
  const id = Number.parseInt(runId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid bid-zone run ID');
  }

  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const { rows } = await db.query(
    `SELECT *
     FROM bid_zone_results
     WHERE run_id = $1
     ORDER BY rank ASC
     LIMIT $2`,
    [id, limit]
  );

  return rows.map((row) => ({
    address: row.token_address,
    symbol: row.symbol || null,
    name: row.name || null,
    monitorPriority: row.monitor_priority || 'dormant',
    mcap: toNumberOrNull(row.mcap),
    catalogMcap: toNumberOrNull(row.catalog_mcap),
    windowMcap: toNumberOrNull(row.window_mcap),
    volume1h: toNumberOrNull(row.volume_1h),
    volume6h: toNumberOrNull(row.volume_6h),
    volume24h: toNumberOrNull(row.volume_24h),
    firstBucketAt: row.first_bucket_at || null,
    lastBucketAt: row.last_bucket_at || null,
    score: toNumberOrNull(row.score),
    liquidityPenalty: toNumberOrNull(row.liquidity_penalty),
    volume1hPenalty: toNumberOrNull(row.volume_1h_penalty),
    supportLevelMcap: toNumberOrNull(row.support_level_mcap),
    resistanceLevelMcap: toNumberOrNull(row.resistance_level_mcap),
    robustRangePct: toNumberOrNull(row.robust_range_pct),
    recentRangePct: toNumberOrNull(row.recent_range_pct),
    closeDriftPct: toNumberOrNull(row.close_drift_pct),
    supportDistancePct: toNumberOrNull(row.support_distance_pct),
    resistanceDistancePct: toNumberOrNull(row.resistance_distance_pct),
    supportTouchClusters: toIntegerOrZero(row.support_touch_clusters),
    coverageRatio: toNumberOrNull(row.coverage_ratio),
    bucketCount: toIntegerOrZero(row.bucket_count),
    sampleCount: toIntegerOrZero(row.sample_count),
    expectedBucketCount: toIntegerOrZero(row.expected_bucket_count),
    ageHours: toNumberOrNull(row.age_hours),
    requestedHours: null,
    minimumWindowHours: toIntegerOrZero(row.minimum_window_hours),
    windowHoursUsed: toIntegerOrZero(row.window_hours_used),
    reasons: row.diagnostics || {},
  }));
}

async function getLatestCompletedRunWithResults(filters = {}, options = {}) {
  const run = await getLatestCompletedRun(filters);
  if (!run) {
    return null;
  }

  const candidates = await listResultsByRunId(run.id, options);
  return {
    id: run.id,
    status: run.status,
    startedAt: run.started_at || null,
    completedAt: run.completed_at || null,
    requestedHours: toIntegerOrZero(run.requested_hours),
    minMcap: toNumberOrNull(run.min_mcap),
    minVol1h: toNumberOrNull(run.min_vol_1h),
    minVol24h: toNumberOrNull(run.min_vol_24h),
    candidateCount: toIntegerOrZero(run.candidate_count),
    resultCount: toIntegerOrZero(run.result_count),
    notes: run.notes || null,
    triggeredBy: run.triggered_by || null,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      requestedHours: toIntegerOrZero(run.requested_hours),
    })),
  };
}

async function cleanupExpiredRuns(options = {}) {
  const maxAgeMs = Math.max(60_000, Number(options.maxAgeMs) || DEFAULT_RETENTION_MS);
  const { rows } = await db.query(
    `DELETE FROM bid_zone_runs
     WHERE status IN ('completed', 'failed')
       AND COALESCE(completed_at, started_at) < NOW() - (($1::bigint || ' milliseconds')::interval)
     RETURNING id`,
    [Math.round(maxAgeMs)]
  );

  return rows.length;
}

module.exports = {
  DEFAULT_MIN_MCAP,
  DEFAULT_MIN_VOL_1H,
  DEFAULT_MIN_VOL_24H,
  DEFAULT_REQUESTED_HOURS,
  DEFAULT_RETENTION_MS,
  cleanupExpiredRuns,
  completeRun,
  failRun,
  getLatestCompletedRun,
  getLatestCompletedRunWithResults,
  listResultsByRunId,
  normalizeRunFilters,
  startRun,
};
