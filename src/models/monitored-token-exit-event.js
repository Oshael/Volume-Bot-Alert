const db = require('./db');
const { isValidAddress } = require('./user-token');

const DEFAULT_MONITORED_MIN_MCAP = 30000;

let ensureTablePromise = null;

function ensureTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS monitored_token_exit_events (
        id SERIAL PRIMARY KEY,
        token_address VARCHAR(64) NOT NULL,
        exit_reason VARCHAR(96) NOT NULL,
        exit_source VARCHAR(64),
        previous_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        current_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_monitored_token_exit_events_token_created
        ON monitored_token_exit_events(token_address, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_monitored_token_exit_events_reason_created
        ON monitored_token_exit_events(exit_reason, created_at DESC, id DESC);
    `);
  }

  return ensureTablePromise;
}

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!isValidAddress(value)) {
    throw new Error('Invalid token address format');
  }
  return value;
}

function normalizeText(value, maxLength = 96) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDashboardMonitored(row, minMcap = DEFAULT_MONITORED_MIN_MCAP) {
  if (!row) {
    return false;
  }
  return row.eligible_for_monitoring === true
    && (toNumberOrNull(row.last_mcap) || 0) >= minMcap;
}

function resolveExitReason(previousRow, currentRow, minMcap = DEFAULT_MONITORED_MIN_MCAP) {
  if (!currentRow) {
    return 'catalog_row_missing';
  }

  const suppressedReason = normalizeText(currentRow.suppressed_reason, 96);
  if (currentRow.eligible_for_monitoring !== true) {
    return suppressedReason || normalizeText(currentRow.eligibility_state, 96) || 'not_eligible';
  }

  const currentMcap = toNumberOrNull(currentRow.last_mcap) || 0;
  if (currentMcap < minMcap) {
    return 'mcap_below_monitored_min';
  }

  const previousMcap = toNumberOrNull(previousRow?.last_mcap) || 0;
  if (previousMcap >= minMcap && currentMcap < minMcap) {
    return 'mcap_below_monitored_min';
  }

  return 'unknown';
}

function buildSnapshot(row) {
  if (!row) {
    return {};
  }

  return {
    address: row.address || row.token_address || null,
    source: row.source || null,
    eligibilityState: row.eligibility_state || null,
    eligibleForMonitoring: row.eligible_for_monitoring ?? null,
    suppressedReason: row.suppressed_reason || null,
    activeMonitorCandidate: row.is_active_monitor_candidate ?? null,
    monitorPriority: row.monitor_priority || null,
    mcap: toNumberOrNull(row.last_mcap),
    liquidityUsd: toNumberOrNull(row.last_liquidity_usd),
    volume5m: toNumberOrNull(row.last_vol_5m),
    volume1h: toNumberOrNull(row.last_vol_1h),
    volume6h: toNumberOrNull(row.last_vol_6h),
    volume24h: toNumberOrNull(row.last_vol_24h),
    lastSeenAt: row.last_seen_at || null,
    lastEvaluatedAt: row.last_evaluated_at || null,
    nextEvaluationAt: row.next_evaluation_at || null,
    evaluationErrorCount: toNumberOrNull(row.evaluation_error_count),
    lastEvaluationError: row.last_evaluation_error || null,
  };
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || null,
    tokenAddress: row.token_address || null,
    exitReason: row.exit_reason || null,
    exitSource: row.exit_source || null,
    previousSnapshot: row.previous_snapshot || {},
    currentSnapshot: row.current_snapshot || {},
    details: row.details || {},
    createdAt: row.created_at || null,
  };
}

async function createEvent(payload = {}, runner = db) {
  await ensureTable();
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const exitReason = normalizeText(payload.exitReason || payload.reason, 96);
  if (!exitReason) {
    throw new Error('Monitored token exit reason is required');
  }

  const { rows } = await runner.query(
    `INSERT INTO monitored_token_exit_events (
       token_address,
       exit_reason,
       exit_source,
       previous_snapshot,
       current_snapshot,
       details
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
     RETURNING *`,
    [
      tokenAddress,
      exitReason,
      normalizeText(payload.exitSource || payload.source, 64),
      JSON.stringify(normalizeJsonObject(payload.previousSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.currentSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.details)),
    ]
  );

  return mapRow(rows[0] || null);
}

async function recordIfExited(previousRow, currentRow, options = {}, runner = db) {
  const minMcap = Number.isFinite(Number(options.minMcap))
    ? Math.max(0, Number(options.minMcap))
    : DEFAULT_MONITORED_MIN_MCAP;
  if (!isDashboardMonitored(previousRow, minMcap) || isDashboardMonitored(currentRow, minMcap)) {
    return null;
  }

  return createEvent({
    tokenAddress: previousRow.address || currentRow?.address,
    exitReason: options.exitReason || resolveExitReason(previousRow, currentRow, minMcap),
    exitSource: options.exitSource,
    previousSnapshot: buildSnapshot(previousRow),
    currentSnapshot: buildSnapshot(currentRow),
    details: {
      minMcap,
      pipeline: normalizeText(options.pipeline, 96),
      evaluationSource: normalizeText(options.evaluationSource, 64),
    },
  }, runner);
}

async function listRecent(options = {}, runner = db) {
  await ensureTable();
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
  const values = [];
  const clauses = [];

  if (options.address != null && String(options.address).trim() !== '') {
    values.push(normalizeAddress(options.address));
    clauses.push(`token_address = $${values.length}`);
  }

  if (options.exitReason != null && String(options.exitReason).trim() !== '') {
    values.push(normalizeText(options.exitReason, 96));
    clauses.push(`exit_reason = $${values.length}`);
  }

  values.push(limit);
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await runner.query(
    `SELECT *
     FROM monitored_token_exit_events
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values
  );

  return rows.map((row) => mapRow(row));
}

module.exports = {
  DEFAULT_MONITORED_MIN_MCAP,
  ensureTable,
  createEvent,
  recordIfExited,
  listRecent,
  __private: {
    buildSnapshot,
    isDashboardMonitored,
    mapRow,
    normalizeAddress,
    normalizeJsonObject,
    normalizeText,
    resolveExitReason,
    toNumberOrNull,
  },
};
