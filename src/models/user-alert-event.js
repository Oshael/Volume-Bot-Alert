const db = require('./db');
const { isValidAddress } = require('./user-token');

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Valid user id is required');
  }
  return userId;
}

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

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (!kind) {
    throw new Error('Alert kind is required');
  }
  if (kind.length > 64) {
    throw new Error('Alert kind must be 64 chars or less');
  }
  return kind;
}

function normalizeTokenAddress(value) {
  const tokenAddress = String(value || '').trim();
  if (!isValidAddress(tokenAddress)) {
    throw new Error('Invalid token address format');
  }
  return tokenAddress;
}

function normalizeDedupeKey(value) {
  const dedupeKey = String(value || '').trim();
  if (!dedupeKey) {
    throw new Error('Alert dedupe key is required');
  }
  if (dedupeKey.length > 255) {
    throw new Error('Alert dedupe key must be 255 chars or less');
  }
  return dedupeKey;
}

function normalizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function mapEventRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || null,
    userId: Number(row.user_id) || null,
    ruleKey: row.rule_key || null,
    kind: row.kind || null,
    tokenAddress: row.token_address || null,
    dedupeKey: row.dedupe_key || null,
    payload: normalizePayload(row.payload),
    triggeredAt: row.triggered_at || null,
    createdAt: row.created_at || null,
  };
}

async function createEvent(payload = {}, runner = db) {
  const userId = normalizeUserId(payload.userId);
  const ruleKey = normalizeRuleKey(payload.ruleKey);
  const kind = normalizeKind(payload.kind);
  const tokenAddress = normalizeTokenAddress(payload.tokenAddress);
  const dedupeKey = normalizeDedupeKey(payload.dedupeKey);
  const eventPayload = normalizePayload(payload.payload);
  const triggeredAt = toTimestampOrNull(payload.triggeredAt) || new Date();

  const { rows } = await runner.query(
    `INSERT INTO user_alert_events (
       user_id,
       rule_key,
       kind,
       token_address,
       dedupe_key,
       payload,
       triggered_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
       rule_key = EXCLUDED.rule_key,
       kind = EXCLUDED.kind,
       token_address = EXCLUDED.token_address,
       payload = EXCLUDED.payload,
       triggered_at = EXCLUDED.triggered_at
     RETURNING *`,
    [
      userId,
      ruleKey,
      kind,
      tokenAddress,
      dedupeKey,
      JSON.stringify(eventPayload),
      triggeredAt,
    ]
  );

  return mapEventRow(rows[0] || null);
}

async function listRecentEvents(filters = {}, runner = db) {
  const userId = normalizeUserId(filters.userId);
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const sort = String(filters.sort || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const values = [userId];
  const clauses = ['user_id = $1'];

  if (filters.ruleKey != null && String(filters.ruleKey).trim() !== '') {
    values.push(normalizeRuleKey(filters.ruleKey));
    clauses.push(`rule_key = $${values.length}`);
  }

  if (filters.tokenAddress != null && String(filters.tokenAddress).trim() !== '') {
    values.push(normalizeTokenAddress(filters.tokenAddress));
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
  const { rows } = await runner.query(
    `SELECT *
     FROM user_alert_events
     WHERE ${clauses.join(' AND ')}
     ORDER BY id ${sort}
     LIMIT $${values.length}`,
    values
  );

  return rows.map((row) => mapEventRow(row));
}

async function getLatestEventId(filters = {}, runner = db) {
  const userId = normalizeUserId(filters.userId);
  const values = [userId];
  const clauses = ['user_id = $1'];

  if (filters.ruleKey != null && String(filters.ruleKey).trim() !== '') {
    values.push(normalizeRuleKey(filters.ruleKey));
    clauses.push(`rule_key = $${values.length}`);
  }

  if (filters.tokenAddress != null && String(filters.tokenAddress).trim() !== '') {
    values.push(normalizeTokenAddress(filters.tokenAddress));
    clauses.push(`token_address = $${values.length}`);
  }

  const { rows } = await runner.query(
    `SELECT MAX(id) AS latest_id
     FROM user_alert_events
     WHERE ${clauses.join(' AND ')}`,
    values
  );

  const latestId = Number(rows[0]?.latest_id);
  return Number.isInteger(latestId) && latestId > 0 ? latestId : null;
}

module.exports = {
  createEvent,
  getLatestEventId,
  listRecentEvents,
  __private: {
    mapEventRow,
    normalizeDedupeKey,
    normalizeKind,
    normalizePayload,
    normalizeRuleKey,
    normalizeTokenAddress,
    normalizeUserId,
    toTimestampOrNull,
  },
};
