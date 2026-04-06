const db = require('./db');
const { isValidAddress } = require('./user-token');

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

function mapEventRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || null,
    ruleKey: row.rule_key || null,
    tokenAddress: row.token_address || null,
    baselineTs: row.baseline_ts || null,
    baselineMcap: toNumberOrNull(row.baseline_mcap),
    windowLowMcap: toNumberOrNull(row.window_low_mcap),
    currentTs: row.current_ts || null,
    currentCloseMcap: toNumberOrNull(row.current_close_mcap),
    dumpPct: toNumberOrNull(row.dump_pct),
    thresholdPct: toNumberOrNull(row.threshold_pct),
    triggeredAt: row.triggered_at || null,
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.created_at || null,
  };
}

async function createEvent(payload = {}, runner = db) {
  const ruleKey = normalizeRuleKey(payload.ruleKey);
  const tokenAddress = String(payload.tokenAddress || '').trim();
  if (!isValidAddress(tokenAddress)) {
    throw new Error('Invalid token address format');
  }

  const baselineTs = toTimestampOrNull(payload.baselineTs);
  const currentTs = toTimestampOrNull(payload.currentTs);
  const baselineMcap = toNumberOrNull(payload.baselineMcap);
  const windowLowMcap = toNumberOrNull(payload.windowLowMcap);
  const currentCloseMcap = toNumberOrNull(payload.currentCloseMcap);
  const dumpPct = toNumberOrNull(payload.dumpPct);
  const thresholdPct = toNumberOrNull(payload.thresholdPct);
  const triggeredAt = toTimestampOrNull(payload.triggeredAt) || new Date();
  const metadata = normalizeMetadata(payload.metadata);

  if (!baselineTs || !currentTs) {
    throw new Error('baselineTs and currentTs are required');
  }
  if (!(baselineMcap > 0) || !(windowLowMcap > 0)) {
    throw new Error('baselineMcap and windowLowMcap must be positive numbers');
  }
  if (dumpPct == null || thresholdPct == null) {
    throw new Error('dumpPct and thresholdPct are required');
  }

  const { rows } = await runner.query(
    `INSERT INTO token_alert_events (
       rule_key,
       token_address,
       baseline_ts,
       baseline_mcap,
       window_low_mcap,
       current_ts,
       current_close_mcap,
       dump_pct,
       threshold_pct,
       triggered_at,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (rule_key, token_address, baseline_ts, current_ts) DO UPDATE SET
       current_close_mcap = COALESCE(EXCLUDED.current_close_mcap, token_alert_events.current_close_mcap),
       dump_pct = EXCLUDED.dump_pct,
       threshold_pct = EXCLUDED.threshold_pct,
       triggered_at = EXCLUDED.triggered_at,
       metadata = EXCLUDED.metadata
     RETURNING *`,
    [
      ruleKey,
      tokenAddress,
      baselineTs,
      baselineMcap,
      windowLowMcap,
      currentTs,
      currentCloseMcap,
      dumpPct,
      thresholdPct,
      triggeredAt,
      JSON.stringify(metadata),
    ]
  );

  return mapEventRow(rows[0] || null);
}

async function listRecentEvents(filters = {}) {
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const sort = String(filters.sort || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const values = [];
  const clauses = [];

  if (filters.ruleKey != null && String(filters.ruleKey).trim() !== '') {
    values.push(normalizeRuleKey(filters.ruleKey));
    clauses.push(`rule_key = $${values.length}`);
  }

  if (filters.tokenAddress != null && String(filters.tokenAddress).trim() !== '') {
    const tokenAddress = String(filters.tokenAddress).trim();
    if (!isValidAddress(tokenAddress)) {
      throw new Error('Invalid token address format');
    }
    values.push(tokenAddress);
    clauses.push(`token_address = $${values.length}`);
  }

  if (filters.afterId != null && String(filters.afterId).trim() !== '') {
    const afterId = Number.parseInt(String(filters.afterId), 10);
    if (!Number.isInteger(afterId) || afterId <= 0) {
      throw new Error('afterId must be a positive integer');
    }
    values.push(afterId);
    clauses.push(`id > $${values.length}`);
  }

  values.push(limit);
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT *
     FROM token_alert_events
     ${whereClause}
     ORDER BY id ${sort}
     LIMIT $${values.length}`,
    values
  );

  return rows.map((row) => mapEventRow(row));
}

module.exports = {
  createEvent,
  listRecentEvents,
  __private: {
    mapEventRow,
    normalizeRuleKey,
    normalizeMetadata,
    toNumberOrNull,
    toTimestampOrNull,
  },
};
