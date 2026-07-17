const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');
const {
  assertAutomaticAlertPublicationAuthorized,
} = require('../services/automatic-alert-publication-guard');

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

function normalizeIdentity(address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  return { chain, address: normalizeTokenAddress(chain, address) };
}

function assertAutomaticAlertsEnabled(chain) {
  if (chain === 'solana') return;
  const error = new Error('Automatic alerts are disabled outside Solana');
  error.code = 'NON_SOLANA_ALERT_TRIGGER_DISABLED';
  throw error;
}

function assertAutomaticEventCreationEnabled(chain, authorization) {
  if (chain === 'solana') return;
  assertAutomaticAlertPublicationAuthorized(authorization, chain);
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

function normalizeRuleKeys(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one alert rule key is required');
  }
  return Array.from(new Set(value.map((item) => normalizeRuleKey(item))));
}

function mapEventRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || null,
    userId: Number(row.user_id) || null,
    ruleKey: row.rule_key || null,
    kind: row.kind || null,
    chain: row.chain || 'solana',
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
  const identity = normalizeIdentity(payload.tokenAddress, payload.chain || 'solana');
  assertAutomaticAlertsEnabled(identity.chain);
  const dedupeKey = normalizeDedupeKey(payload.dedupeKey);
  const eventPayload = normalizePayload(payload.payload);
  const triggeredAt = toTimestampOrNull(payload.triggeredAt) || new Date();

  const { rows } = await runner.query(
    `INSERT INTO user_alert_events (
       user_id,
       rule_key,
       kind,
       chain,
       token_address,
       dedupe_key,
       payload,
       triggered_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (user_id, chain, dedupe_key) DO UPDATE SET
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
      identity.chain,
      identity.address,
      dedupeKey,
      JSON.stringify(eventPayload),
      triggeredAt,
    ]
  );

  return mapEventRow(rows[0] || null);
}

async function createEventOnce(payload = {}, options = {}) {
  const runner = options.db && typeof options.db.query === 'function' ? options.db : db;
  const userId = normalizeUserId(payload.userId);
  const ruleKey = normalizeRuleKey(payload.ruleKey);
  const kind = normalizeKind(payload.kind);
  const identity = normalizeIdentity(payload.tokenAddress, payload.chain || 'solana');
  assertAutomaticEventCreationEnabled(identity.chain, options.authorization);
  const dedupeKey = normalizeDedupeKey(payload.dedupeKey);
  const eventPayload = normalizePayload(payload.payload);
  const triggeredAt = toTimestampOrNull(payload.triggeredAt) || new Date();

  const { rows } = await runner.query(
    `INSERT INTO user_alert_events (
       user_id,
       rule_key,
       kind,
       chain,
       token_address,
       dedupe_key,
       payload,
       triggered_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (user_id, chain, dedupe_key) DO NOTHING
     RETURNING *`,
    [
      userId,
      ruleKey,
      kind,
      identity.chain,
      identity.address,
      dedupeKey,
      JSON.stringify(eventPayload),
      triggeredAt,
    ]
  );

  return mapEventRow(rows[0] || null);
}

async function listRecentEvents(filters = {}, runner = db) {
  const userId = normalizeUserId(filters.userId);
  const chain = normalizeTokenChain(filters.chain || 'solana');
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const sort = String(filters.sort || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const values = [userId, chain];
  const clauses = ['user_id = $1', 'chain = $2'];

  if (filters.ruleKey != null && String(filters.ruleKey).trim() !== '') {
    values.push(normalizeRuleKey(filters.ruleKey));
    clauses.push(`rule_key = $${values.length}`);
  }

  if (filters.tokenAddress != null && String(filters.tokenAddress).trim() !== '') {
    values.push(normalizeTokenAddress(chain, filters.tokenAddress));
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

  if (filters.dismissedByUserId != null) {
    values.push(normalizeUserId(filters.dismissedByUserId));
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM alert_event_dismissals dismissal
      WHERE dismissal.user_id = $${values.length}
        AND dismissal.rule_key = user_alert_events.rule_key
        AND dismissal.chain = user_alert_events.chain
        AND dismissal.event_id = user_alert_events.id
    )`);
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

async function listChartEvents(filters = {}, runner = db) {
  const userId = normalizeUserId(filters.userId);
  const chain = normalizeTokenChain(filters.chain || 'solana');
  const tokenAddress = normalizeTokenAddress(chain, filters.tokenAddress);
  const triggeredAfter = toTimestampOrNull(filters.triggeredAfter);
  if (!triggeredAfter) {
    throw new Error('Valid chart alert cutoff is required');
  }
  const ruleKeys = normalizeRuleKeys(filters.ruleKeys);
  const limit = Math.max(1, Math.min(Number(filters.limit) || 501, 1001));

  const { rows } = await runner.query(
    `SELECT *
     FROM user_alert_events
     WHERE user_id = $1
       AND chain = $2
       AND token_address = $3
       AND triggered_at >= $4
       AND rule_key = ANY($5::text[])
     ORDER BY triggered_at ASC, id ASC
     LIMIT $6`,
    [userId, chain, tokenAddress, triggeredAfter, ruleKeys, limit]
  );

  return rows.map((row) => mapEventRow(row));
}

async function getLatestEventId(filters = {}, runner = db) {
  const userId = normalizeUserId(filters.userId);
  const chain = normalizeTokenChain(filters.chain || 'solana');
  const values = [userId, chain];
  const clauses = ['user_id = $1', 'chain = $2'];

  if (filters.ruleKey != null && String(filters.ruleKey).trim() !== '') {
    values.push(normalizeRuleKey(filters.ruleKey));
    clauses.push(`rule_key = $${values.length}`);
  }

  if (filters.tokenAddress != null && String(filters.tokenAddress).trim() !== '') {
    values.push(normalizeTokenAddress(chain, filters.tokenAddress));
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

async function getEventForUser(eventId, userId, runner = db) {
  const normalizedEventId = Number.parseInt(String(eventId || '').trim(), 10);
  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) {
    throw new Error('Valid alert event id is required');
  }

  const normalizedUserId = normalizeUserId(userId);
  const { rows } = await runner.query(
    `SELECT *
     FROM user_alert_events
     WHERE id = $1
       AND user_id = $2`,
    [normalizedEventId, normalizedUserId]
  );

  return mapEventRow(rows[0] || null);
}

module.exports = {
  createEvent,
  createEventOnce,
  getEventForUser,
  getLatestEventId,
  listChartEvents,
  listRecentEvents,
  __private: {
    mapEventRow,
    normalizeIdentity,
    normalizeDedupeKey,
    normalizeKind,
    normalizePayload,
    normalizeRuleKey,
    normalizeRuleKeys,
    normalizeUserId,
    toTimestampOrNull,
  },
};
