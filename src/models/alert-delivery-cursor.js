const db = require('./db');

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

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Valid user id is required');
  }
  return userId;
}

function toEventIdOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const eventId = Number.parseInt(String(value), 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error('Event id must be a positive integer');
  }
  return eventId;
}

function mapCursorRow(row) {
  if (!row) return null;
  return {
    userId: Number(row.user_id) || null,
    ruleKey: row.rule_key || null,
    lastSeenEventId: row.last_seen_event_id == null ? null : Number(row.last_seen_event_id),
    lastAckedEventId: row.last_acked_event_id == null ? null : Number(row.last_acked_event_id),
    updatedAt: row.updated_at || null,
  };
}

function normalizeCursorPayload(payload = {}) {
  const lastSeenEventId = toEventIdOrNull(payload.lastSeenEventId);
  const lastAckedEventId = toEventIdOrNull(payload.lastAckedEventId);

  return {
    userId: normalizeUserId(payload.userId),
    ruleKey: normalizeRuleKey(payload.ruleKey),
    lastSeenEventId: lastSeenEventId == null && lastAckedEventId == null
      ? null
      : Math.max(lastSeenEventId || 0, lastAckedEventId || 0) || null,
    lastAckedEventId,
  };
}

async function getCursor(userId, ruleKey, runner = db) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedRuleKey = normalizeRuleKey(ruleKey);
  const { rows } = await runner.query(
    `SELECT *
     FROM alert_delivery_cursors
     WHERE user_id = $1
       AND rule_key = $2
     LIMIT 1`,
    [normalizedUserId, normalizedRuleKey]
  );

  return mapCursorRow(rows[0] || null);
}

async function upsertCursor(payload = {}, runner = db) {
  const normalized = normalizeCursorPayload(payload);
  const { rows } = await runner.query(
    `INSERT INTO alert_delivery_cursors (
       user_id,
       rule_key,
       last_seen_event_id,
       last_acked_event_id,
       updated_at
     )
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, rule_key) DO UPDATE SET
       last_seen_event_id = CASE
         WHEN EXCLUDED.last_seen_event_id IS NULL THEN alert_delivery_cursors.last_seen_event_id
         WHEN alert_delivery_cursors.last_seen_event_id IS NULL THEN EXCLUDED.last_seen_event_id
         ELSE GREATEST(alert_delivery_cursors.last_seen_event_id, EXCLUDED.last_seen_event_id)
       END,
       last_acked_event_id = CASE
         WHEN EXCLUDED.last_acked_event_id IS NULL THEN alert_delivery_cursors.last_acked_event_id
         WHEN alert_delivery_cursors.last_acked_event_id IS NULL THEN EXCLUDED.last_acked_event_id
         ELSE GREATEST(alert_delivery_cursors.last_acked_event_id, EXCLUDED.last_acked_event_id)
       END,
       updated_at = NOW()
     RETURNING *`,
    [
      normalized.userId,
      normalized.ruleKey,
      normalized.lastSeenEventId,
      normalized.lastAckedEventId,
    ]
  );

  return mapCursorRow(rows[0] || null);
}

async function markSeen(userId, ruleKey, lastSeenEventId, runner = db) {
  return upsertCursor({ userId, ruleKey, lastSeenEventId }, runner);
}

async function markAcked(userId, ruleKey, lastAckedEventId, runner = db) {
  return upsertCursor({ userId, ruleKey, lastAckedEventId }, runner);
}

module.exports = {
  getCursor,
  markAcked,
  markSeen,
  upsertCursor,
  __private: {
    mapCursorRow,
    normalizeCursorPayload,
    normalizeRuleKey,
    normalizeUserId,
    toEventIdOrNull,
  },
};
