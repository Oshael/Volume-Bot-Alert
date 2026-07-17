const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

const DEFAULT_MONITORED_MIN_MCAP = 30000;
const EVENT_SEMANTICS = Object.freeze({
  version: 1,
  scope: 'legacy-signal-eligibility',
  workspaceExit: false,
});

let ensureTablePromise = null;

function ensureTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS monitored_token_exit_events (
        id SERIAL PRIMARY KEY,
        chain VARCHAR(16) NOT NULL DEFAULT 'solana',
        token_address VARCHAR(64) NOT NULL,
        exit_reason VARCHAR(96) NOT NULL,
        exit_source VARCHAR(64),
        previous_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        current_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE monitored_token_exit_events
        ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana';

      CREATE INDEX IF NOT EXISTS idx_monitored_exit_events_chain_token
        ON monitored_token_exit_events(chain, token_address, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_monitored_token_exit_events_reason_created
        ON monitored_token_exit_events(exit_reason, created_at DESC, id DESC);
    `);
  }

  return ensureTablePromise;
}

function normalizeIdentity(address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  return { chain, address: normalizeTokenAddress(chain, address) };
}

function assertExitDetectionEnabled(chain) {
  if (chain === 'solana') return;
  const error = new Error('Legacy signal-eligibility exit detection only supports Solana');
  error.code = 'NON_SOLANA_EXIT_EVENT_DISABLED';
  throw error;
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

function normalizeEventDetails(value) {
  return {
    ...normalizeJsonObject(value),
    semanticVersion: EVENT_SEMANTICS.version,
    scope: EVENT_SEMANTICS.scope,
    workspaceExit: EVENT_SEMANTICS.workspaceExit,
  };
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLegacySignalEligible(row, minMcap = DEFAULT_MONITORED_MIN_MCAP) {
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
    chain: row.chain || 'solana',
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
    chain: row.chain || 'solana',
    tokenAddress: row.token_address || null,
    exitReason: row.exit_reason || null,
    exitSource: row.exit_source || null,
    previousSnapshot: row.previous_snapshot || {},
    currentSnapshot: row.current_snapshot || {},
    details: row.details || {},
    createdAt: row.created_at || null,
    semantics: EVENT_SEMANTICS,
  };
}

async function createEvent(payload = {}, runner = db) {
  const identity = normalizeIdentity(
    payload.tokenAddress || payload.address,
    payload.chain || 'solana'
  );
  assertExitDetectionEnabled(identity.chain);
  await ensureTable();
  const exitReason = normalizeText(payload.exitReason || payload.reason, 96);
  if (!exitReason) {
    throw new Error('Monitored token exit reason is required');
  }

  const { rows } = await runner.query(
    `INSERT INTO monitored_token_exit_events (
       chain,
       token_address,
       exit_reason,
       exit_source,
       previous_snapshot,
       current_snapshot,
       details
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
     RETURNING *`,
    [
      identity.chain,
      identity.address,
      exitReason,
      normalizeText(payload.exitSource || payload.source, 64),
      JSON.stringify(normalizeJsonObject(payload.previousSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.currentSnapshot)),
      JSON.stringify(normalizeEventDetails(payload.details)),
    ]
  );

  return mapRow(rows[0] || null);
}

async function recordIfExited(previousRow, currentRow, options = {}, runner = db) {
  const minMcap = Number.isFinite(Number(options.minMcap))
    ? Math.max(0, Number(options.minMcap))
    : DEFAULT_MONITORED_MIN_MCAP;
  if (
    !isLegacySignalEligible(previousRow, minMcap)
    || isLegacySignalEligible(currentRow, minMcap)
  ) {
    return null;
  }

  return createEvent({
    chain: options.chain || previousRow?.chain || currentRow?.chain || 'solana',
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
  const chain = normalizeTokenChain(options.chain || 'solana');
  values.push(chain);
  clauses.push(`chain = $${values.length}`);

  if (options.address != null && String(options.address).trim() !== '') {
    values.push(normalizeTokenAddress(chain, options.address));
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
  EVENT_SEMANTICS,
  ensureTable,
  createEvent,
  recordIfExited,
  listRecent,
  __private: {
    buildSnapshot,
    isLegacySignalEligible,
    mapRow,
    normalizeEventDetails,
    normalizeIdentity,
    normalizeJsonObject,
    normalizeText,
    resolveExitReason,
    toNumberOrNull,
  },
};
