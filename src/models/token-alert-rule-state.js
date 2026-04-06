const db = require('./db');
const { isValidAddress } = require('./user-token');

const VALID_STATUSES = new Set(['idle', 'triggered', 'rearmed']);

function normalizeRuleKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Alert rule key is required');
  }
  if (normalized.length > 64) {
    throw new Error('Alert rule key must be 64 chars or less');
  }
  return normalized;
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!VALID_STATUSES.has(normalized)) {
    return 'idle';
  }
  return normalized;
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function mapStateRow(row) {
  if (!row) return null;
  return {
    ruleKey: row.rule_key || null,
    tokenAddress: row.token_address || null,
    status: normalizeStatus(row.status),
    lastBaselineTs: row.last_baseline_ts || null,
    lastBaselineMcap: toNumberOrNull(row.last_baseline_mcap),
    lastWindowLowMcap: toNumberOrNull(row.last_window_low_mcap),
    lastCurrentTs: row.last_current_ts || null,
    lastCurrentCloseMcap: toNumberOrNull(row.last_current_close_mcap),
    lastAlertedAt: row.last_alerted_at || null,
    lastAlertedPct: toNumberOrNull(row.last_alerted_pct),
    rearmRequired: Boolean(row.rearm_required),
    metadata: normalizeMetadata(row.metadata),
    updatedAt: row.updated_at || null,
  };
}

async function getState(ruleKey, tokenAddress, runner = db) {
  const normalizedRuleKey = normalizeRuleKey(ruleKey);
  const normalizedAddress = String(tokenAddress || '').trim();
  if (!isValidAddress(normalizedAddress)) {
    throw new Error('Invalid token address format');
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM token_alert_rule_state
     WHERE rule_key = $1
       AND token_address = $2
     LIMIT 1`,
    [normalizedRuleKey, normalizedAddress]
  );

  return mapStateRow(rows[0] || null);
}

async function upsertState(payload = {}, runner = db) {
  const ruleKey = normalizeRuleKey(payload.ruleKey);
  const tokenAddress = String(payload.tokenAddress || '').trim();
  if (!isValidAddress(tokenAddress)) {
    throw new Error('Invalid token address format');
  }

  const status = normalizeStatus(payload.status);
  const lastBaselineTs = toTimestampOrNull(payload.lastBaselineTs);
  const lastBaselineMcap = toNumberOrNull(payload.lastBaselineMcap);
  const lastWindowLowMcap = toNumberOrNull(payload.lastWindowLowMcap);
  const lastCurrentTs = toTimestampOrNull(payload.lastCurrentTs);
  const lastCurrentCloseMcap = toNumberOrNull(payload.lastCurrentCloseMcap);
  const lastAlertedAt = toTimestampOrNull(payload.lastAlertedAt);
  const lastAlertedPct = toNumberOrNull(payload.lastAlertedPct);
  const rearmRequired = Boolean(payload.rearmRequired);
  const metadata = normalizeMetadata(payload.metadata);

  const { rows } = await runner.query(
    `INSERT INTO token_alert_rule_state (
       rule_key,
       token_address,
       status,
       last_baseline_ts,
       last_baseline_mcap,
       last_window_low_mcap,
       last_current_ts,
       last_current_close_mcap,
       last_alerted_at,
       last_alerted_pct,
       rearm_required,
       metadata,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
     ON CONFLICT (rule_key, token_address) DO UPDATE SET
       status = EXCLUDED.status,
       last_baseline_ts = EXCLUDED.last_baseline_ts,
       last_baseline_mcap = EXCLUDED.last_baseline_mcap,
       last_window_low_mcap = EXCLUDED.last_window_low_mcap,
       last_current_ts = EXCLUDED.last_current_ts,
       last_current_close_mcap = EXCLUDED.last_current_close_mcap,
       last_alerted_at = EXCLUDED.last_alerted_at,
       last_alerted_pct = EXCLUDED.last_alerted_pct,
       rearm_required = EXCLUDED.rearm_required,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      ruleKey,
      tokenAddress,
      status,
      lastBaselineTs,
      lastBaselineMcap,
      lastWindowLowMcap,
      lastCurrentTs,
      lastCurrentCloseMcap,
      lastAlertedAt,
      lastAlertedPct,
      rearmRequired,
      JSON.stringify(metadata),
    ]
  );

  return mapStateRow(rows[0] || null);
}

module.exports = {
  VALID_STATUSES,
  getState,
  upsertState,
  __private: {
    mapStateRow,
    normalizeMetadata,
    normalizeRuleKey,
    normalizeStatus,
    toNumberOrNull,
    toTimestampOrNull,
  },
};
