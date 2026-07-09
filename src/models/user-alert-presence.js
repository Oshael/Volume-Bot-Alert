const db = require('./db');

const FOREGROUND_TTL_MS = 2 * 60 * 1000;
const HIDDEN_GRACE_MAX_MS = 20 * 60 * 1000;
const PRESENCE_MODES = new Set(['foreground', 'hidden', 'inactive']);

function getRunner(runner) {
  return runner && typeof runner.query === 'function' ? runner : db;
}

function normalizeUserId(value) {
  const userId = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Valid user id is required');
  }
  return userId;
}

function normalizeText(value, fieldName, maxLength = 128) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} chars or less`);
  }
  return normalized;
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return PRESENCE_MODES.has(mode) ? mode : 'inactive';
}

function normalizeHiddenGraceMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return HIDDEN_GRACE_MAX_MS;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), HIDDEN_GRACE_MAX_MS));
}

function normalizeDate(value, fallback = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value || fallback);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('Valid timestamp is required');
  }
  return parsed;
}

function resolveNow(options = {}) {
  if (Number.isFinite(Number(options.nowMs))) {
    return new Date(Number(options.nowMs));
  }
  return normalizeDate(options.now || new Date());
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function mapPresenceRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || null,
    userId: Number(row.user_id) || null,
    sessionKey: row.session_key || null,
    socketId: row.socket_id || null,
    webInstanceId: row.web_instance_id || null,
    mode: row.mode || null,
    lastHeartbeatAt: toIsoOrNull(row.last_heartbeat_at),
    foregroundSeenAt: toIsoOrNull(row.foreground_seen_at),
    hiddenStartedAt: toIsoOrNull(row.hidden_started_at),
    hiddenGraceUntilAt: toIsoOrNull(row.hidden_grace_until_at),
    activeUntilAt: toIsoOrNull(row.active_until_at),
    disconnectedAt: toIsoOrNull(row.disconnected_at),
    createdAt: toIsoOrNull(row.created_at),
    updatedAt: toIsoOrNull(row.updated_at),
  };
}

function buildPresenceTimestamps(mode, hiddenGraceMs, now) {
  if (mode === 'foreground') {
    return {
      foregroundSeenAt: now,
      hiddenStartedAt: null,
      hiddenGraceUntilAt: null,
      activeUntilAt: addMs(now, FOREGROUND_TTL_MS),
    };
  }

  if (mode === 'hidden') {
    const hiddenGraceUntilAt = addMs(now, hiddenGraceMs);
    return {
      foregroundSeenAt: null,
      hiddenStartedAt: now,
      hiddenGraceUntilAt,
      activeUntilAt: hiddenGraceUntilAt,
    };
  }

  return {
    foregroundSeenAt: null,
    hiddenStartedAt: null,
    hiddenGraceUntilAt: null,
    activeUntilAt: now,
  };
}

async function upsert(payload = {}, options = {}, runner = db) {
  const userId = normalizeUserId(payload.userId);
  const sessionKey = normalizeText(payload.sessionKey, 'Session key');
  const socketId = normalizeText(payload.socketId, 'Socket id');
  const webInstanceId = normalizeText(payload.webInstanceId, 'Web instance id');
  const mode = normalizeMode(payload.mode);
  const hiddenGraceMs = mode === 'hidden' ? normalizeHiddenGraceMs(payload.hiddenGraceMs) : 0;
  const now = resolveNow(options);
  const timestamps = buildPresenceTimestamps(mode, hiddenGraceMs, now);
  const executor = getRunner(runner);

  const { rows } = await executor.query(
    `INSERT INTO user_alert_presences (
       user_id,
       session_key,
       socket_id,
       web_instance_id,
       mode,
       last_heartbeat_at,
       foreground_seen_at,
       hidden_started_at,
       hidden_grace_until_at,
       active_until_at,
       disconnected_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $6)
     ON CONFLICT (web_instance_id, socket_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       session_key = EXCLUDED.session_key,
       mode = EXCLUDED.mode,
       last_heartbeat_at = EXCLUDED.last_heartbeat_at,
       foreground_seen_at = EXCLUDED.foreground_seen_at,
       hidden_started_at = CASE
         WHEN EXCLUDED.mode = 'hidden'
          AND user_alert_presences.mode = 'hidden'
          AND user_alert_presences.disconnected_at IS NULL
          AND user_alert_presences.hidden_started_at IS NOT NULL
           THEN user_alert_presences.hidden_started_at
         ELSE EXCLUDED.hidden_started_at
       END,
       hidden_grace_until_at = EXCLUDED.hidden_grace_until_at,
       active_until_at = EXCLUDED.active_until_at,
       disconnected_at = NULL,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      userId,
      sessionKey,
      socketId,
      webInstanceId,
      mode,
      now,
      timestamps.foregroundSeenAt,
      timestamps.hiddenStartedAt,
      timestamps.hiddenGraceUntilAt,
      timestamps.activeUntilAt,
    ]
  );

  return mapPresenceRow(rows[0] || null);
}

async function disconnect(payload = {}, options = {}, runner = db) {
  const socketId = normalizeText(payload.socketId, 'Socket id');
  const webInstanceId = normalizeText(payload.webInstanceId, 'Web instance id');
  const now = resolveNow(options);
  const executor = getRunner(runner);

  const { rows } = await executor.query(
    `UPDATE user_alert_presences
     SET mode = 'inactive',
         active_until_at = $3,
         disconnected_at = $3,
         updated_at = $3
     WHERE web_instance_id = $1
       AND socket_id = $2
       AND disconnected_at IS NULL
     RETURNING *`,
    [webInstanceId, socketId, now]
  );

  return mapPresenceRow(rows[0] || null);
}

async function listActive(filters = {}, options = {}, runner = db) {
  const now = resolveNow(options);
  const values = [now];
  const clauses = [
    'disconnected_at IS NULL',
    "mode <> 'inactive'",
    'active_until_at > $1',
  ];

  if (filters.userId != null) {
    values.push(normalizeUserId(filters.userId));
    clauses.push(`user_id = $${values.length}`);
  }

  const executor = getRunner(runner);
  const { rows } = await executor.query(
    `SELECT *
     FROM user_alert_presences
     WHERE ${clauses.join(' AND ')}
     ORDER BY user_id ASC,
              CASE WHEN mode = 'foreground' THEN 0 ELSE 1 END ASC,
              active_until_at DESC,
              id ASC`,
    values
  );

  return rows.map(mapPresenceRow);
}

async function cleanupExpired(options = {}, runner = db) {
  const now = resolveNow(options);
  const executor = getRunner(runner);
  const { rowCount } = await executor.query(
    `DELETE FROM user_alert_presences
     WHERE disconnected_at IS NOT NULL
        OR active_until_at <= $1`,
    [now]
  );
  return rowCount || 0;
}

module.exports = {
  FOREGROUND_TTL_MS,
  HIDDEN_GRACE_MAX_MS,
  PRESENCE_MODES,
  cleanupExpired,
  disconnect,
  listActive,
  upsert,
  __private: {
    buildPresenceTimestamps,
    mapPresenceRow,
    normalizeDate,
    normalizeHiddenGraceMs,
    normalizeMode,
    normalizeText,
    normalizeUserId,
    resolveNow,
  },
};
