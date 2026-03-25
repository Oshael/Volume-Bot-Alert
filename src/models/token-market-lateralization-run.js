const db = require('./db');
const { isValidAddress } = require('./user-token');

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIntegerOrZero(value) {
  const num = Number.parseInt(value, 10);
  return Number.isInteger(num) ? num : 0;
}

async function startRun(options = {}) {
  const requestedHours = Math.max(1, Math.min(Number(options.requestedHours) || 6, 48));
  const minMcap = Math.max(90_000, Number(options.minMcap) || 90_000);
  const minVol24h = Math.max(0, Number(options.minVol24h) || 10_000);
  const notes = String(options.notes || '').trim() || null;
  const triggeredBy = String(options.triggeredBy || 'worker').trim().toLowerCase() || 'worker';

  const { rows } = await db.query(
    `INSERT INTO lateralization_runs (
       status,
       requested_hours,
       min_mcap,
       min_vol_24h,
       notes,
       triggered_by
     )
     VALUES ('running', $1, $2, $3, $4, $5)
     RETURNING *`,
    [requestedHours, minMcap, minVol24h, notes, triggeredBy]
  );

  return rows[0] || null;
}

async function failRun(runId, errorMessage) {
  const id = Number.parseInt(runId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid lateralization run ID');
  }

  const { rows } = await db.query(
    `UPDATE lateralization_runs
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
    throw new Error('Invalid lateralization run ID');
  }

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidateCount = Math.max(0, Number(payload.candidateCount) || candidates.length);
  const resultCount = candidates.length;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE lateralization_runs
       SET status = 'completed',
           completed_at = NOW(),
           candidate_count = $2,
           result_count = $3,
           error_message = NULL
       WHERE id = $1`,
      [id, candidateCount, resultCount]
    );

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index] || {};
      const address = String(candidate.address || '').trim();
      if (!isValidAddress(address)) {
        continue;
      }

      await client.query(
        `INSERT INTO lateralization_results (
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
           range_pct,
           range_limit_pct,
           drift_pct,
           drift_limit_pct,
           coverage_ratio,
           bucket_count,
           sample_count,
           expected_bucket_count,
           age_hours,
           current_position_pct,
           window_hours_used,
           minimum_window_hours,
           liquidity_penalty,
           monitor_priority,
           first_bucket_at,
           last_bucket_at,
           diagnostics
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, $17,
           $18, $19, $20, $21, $22, $23, $24, $25,
           $26, $27, $28, $29::jsonb
         )`,
        [
          id,
          address,
          index + 1,
          String(candidate.symbol || '').trim() || null,
          String(candidate.name || '').trim() || null,
          toNumberOrNull(candidate.score),
          toNumberOrNull(candidate.mcap),
          toNumberOrNull(candidate.catalogMcap),
          toNumberOrNull(candidate.windowMcap),
          toNumberOrNull(candidate.volume1h),
          toNumberOrNull(candidate.volume6h),
          toNumberOrNull(candidate.volume24h),
          toNumberOrNull(candidate.rangePct),
          toNumberOrNull(candidate.rangeLimitPct),
          toNumberOrNull(candidate.driftPct),
          toNumberOrNull(candidate.driftLimitPct),
          toNumberOrNull(candidate.coverageRatio),
          toIntegerOrZero(candidate.bucketCount),
          toIntegerOrZero(candidate.sampleCount),
          toIntegerOrZero(candidate.expectedBucketCount),
          toNumberOrNull(candidate.ageHours),
          toNumberOrNull(candidate.currentPositionPct),
          toIntegerOrZero(candidate.windowHoursUsed),
          toIntegerOrZero(candidate.minimumWindowHours),
          toNumberOrNull(candidate.liquidityPenalty),
          String(candidate.monitorPriority || '').trim() || null,
          candidate.firstBucketAt || null,
          candidate.lastBucketAt || null,
          JSON.stringify(candidate.reasons || {}),
        ]
      );
    }

    const { rows } = await client.query(
      'SELECT * FROM lateralization_runs WHERE id = $1 LIMIT 1',
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
  const requestedHours = Math.max(1, Math.min(Number(filters.requestedHours) || 6, 48));
  const minMcap = Math.max(90_000, Number(filters.minMcap) || 90_000);
  const minVol24h = Math.max(0, Number(filters.minVol24h) || 10_000);

  const { rows } = await db.query(
    `SELECT *
     FROM lateralization_runs
     WHERE status = 'completed'
       AND requested_hours = $1
       AND min_mcap = $2
       AND min_vol_24h = $3
     ORDER BY completed_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [requestedHours, minMcap, minVol24h]
  );

  return rows[0] || null;
}

async function listResultsByRunId(runId, options = {}) {
  const id = Number.parseInt(runId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid lateralization run ID');
  }

  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const { rows } = await db.query(
    `SELECT *
     FROM lateralization_results
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
    rangePct: toNumberOrNull(row.range_pct),
    rangeLimitPct: toNumberOrNull(row.range_limit_pct),
    driftPct: toNumberOrNull(row.drift_pct),
    driftLimitPct: toNumberOrNull(row.drift_limit_pct),
    coverageRatio: toNumberOrNull(row.coverage_ratio),
    bucketCount: toIntegerOrZero(row.bucket_count),
    sampleCount: toIntegerOrZero(row.sample_count),
    expectedBucketCount: toIntegerOrZero(row.expected_bucket_count),
    ageHours: toNumberOrNull(row.age_hours),
    currentPositionPct: toNumberOrNull(row.current_position_pct),
    volume1hPenalty: toNumberOrNull(row.liquidity_penalty),
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

module.exports = {
  completeRun,
  failRun,
  getLatestCompletedRun,
  getLatestCompletedRunWithResults,
  listResultsByRunId,
  startRun,
};
