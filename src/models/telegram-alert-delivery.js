const { query } = require('./db');
const { RULE_CONTRACTS } = require('../services/telegram-alert-rule-contracts');
const { normalizeTokenAddress } = require('../utils/token-identity');

const runner = (db) => (db && typeof db.query === 'function' ? db : { query });
const DEFAULT_CLAIM_LIMIT = 25;
const DEFAULT_LEASE_MS = 60_000;
const SETTLEMENT_STATUSES = new Set(['sent', 'retry', 'failed', 'cancelled']);

class TelegramAlertDeliveryConflictError extends Error {
  constructor(message = 'Telegram alert delivery conflicts with an existing dedupe key') {
    super(message);
    this.name = 'TelegramAlertDeliveryConflictError';
    this.code = 'delivery_conflict';
  }
}

function positiveId(value, field) {
  try {
    const normalized = BigInt(String(value ?? '').trim());
    if (normalized > 0n) return normalized.toString();
  } catch (_) {}
  throw new TypeError(`${field} must be a positive integer`);
}

function requiredText(value, field, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function boundedInteger(value, field, fallback, min, max) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function leaseOwner(value) {
  return requiredText(value, 'lease owner', 128);
}

function claimIds(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw new TypeError('claim ids must contain 1-100 delivery ids');
  }
  return [...new Set(values.map((value) => positiveId(value, 'delivery id')))];
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, field, maxLength);
}

function normalizeSettlement(input = {}, status) {
  if (!SETTLEMENT_STATUSES.has(status)) {
    throw new TypeError(`Unsupported Telegram delivery settlement: ${status}`);
  }
  const value = {
    id: positiveId(input.id, 'delivery id'),
    owner: leaseOwner(input.owner),
    status,
    nextAttemptAt: null,
    messageId: null,
    fileId: null,
    errorCode: null,
    error: null,
  };
  if (status === 'sent') {
    value.messageId = positiveId(input.messageId, 'Telegram message id');
    value.fileId = optionalText(input.fileId, 'Telegram file id', 2048);
    return value;
  }
  value.errorCode = requiredText(input.errorCode, 'delivery error code', 64);
  value.error = requiredText(input.error, 'delivery error', 2000);
  if (status === 'retry') {
    value.nextAttemptAt = timestamp(input.nextAttemptAt, 'nextAttemptAt');
  }
  return value;
}

function normalizeIntent(input = {}) {
  const chain = String(input.chain || '').trim();
  const ruleKey = String(input.ruleKey || '').trim();
  if (!RULE_CONTRACTS[chain]?.[ruleKey]) {
    throw new TypeError(`Unsupported Telegram alert rule: ${chain}/${ruleKey}`);
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new TypeError('Telegram alert payload must be an object');
  }
  return {
    connectionId: positiveId(input.connectionId, 'connection id'),
    profileId: positiveId(input.profileId, 'profile id'),
    chain,
    ruleKey,
    tokenAddress: normalizeTokenAddress(chain, input.tokenAddress),
    dedupeKey: requiredText(input.dedupeKey, 'dedupe key', 255),
    eventPayload: JSON.stringify({
      kind: requiredText(input.kind, 'alert kind', 64),
      payload: input.payload,
    }),
    triggeredAt: timestamp(input.triggeredAt, 'triggeredAt'),
  };
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    profileId: String(row.profile_id),
    ruleKey: row.rule_key,
    chain: row.chain,
    tokenAddress: row.token_address,
    dedupeKey: row.dedupe_key,
    eventPayload: row.event_payload,
    triggeredAt: row.triggered_at,
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    telegramMessageId: row.telegram_message_id == null
      ? null
      : String(row.telegram_message_id),
    telegramFileId: row.telegram_file_id,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createPending(input, db) {
  const value = normalizeIntent(input);
  const params = [
    value.connectionId,
    value.profileId,
    value.ruleKey,
    value.chain,
    value.tokenAddress,
    value.dedupeKey,
    value.eventPayload,
    value.triggeredAt,
  ];
  const database = runner(db);
  const inserted = await database.query(
    `INSERT INTO telegram_alert_deliveries (
       connection_id, profile_id, rule_key, chain, token_address,
       dedupe_key, event_payload, triggered_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
     ON CONFLICT (connection_id, dedupe_key) DO NOTHING
     RETURNING *`,
    params
  );
  if (inserted.rows[0]) {
    return { created: true, delivery: mapRow(inserted.rows[0]) };
  }

  const existing = await database.query(
    `SELECT *
     FROM telegram_alert_deliveries
     WHERE connection_id = $1
       AND profile_id = $2
       AND rule_key = $3
       AND chain = $4
       AND token_address = $5
       AND dedupe_key = $6
       AND event_payload = $7::jsonb
       AND triggered_at = $8::timestamptz
     LIMIT 1`,
    params
  );
  if (!existing.rows[0]) throw new TelegramAlertDeliveryConflictError();
  return { created: false, delivery: mapRow(existing.rows[0]) };
}

async function claimReadyBatch(input = {}, db) {
  const owner = leaseOwner(input.owner);
  const limit = boundedInteger(
    input.limit, 'claim limit', DEFAULT_CLAIM_LIMIT, 1, 100
  );
  const leaseMs = boundedInteger(
    input.leaseMs, 'lease duration', DEFAULT_LEASE_MS, 1_000, 10 * 60 * 1_000
  );
  const { rows } = await runner(db).query(
    `WITH claimable AS MATERIALIZED (
       SELECT id
       FROM telegram_alert_deliveries
       WHERE (
         (status IN ('pending', 'retry') AND next_attempt_at <= NOW())
         OR (status = 'claimed' AND lease_until <= NOW())
       )
       ORDER BY COALESCE(lease_until, next_attempt_at), id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE telegram_alert_deliveries AS deliveries
     SET status = 'claimed',
         attempts = deliveries.attempts + 1,
         lease_owner = $2,
         lease_until = NOW() + ($3::int * INTERVAL '1 millisecond'),
         updated_at = NOW()
     FROM claimable
     WHERE deliveries.id = claimable.id
     RETURNING deliveries.*`,
    [limit, owner, leaseMs]
  );
  return rows.map(mapRow);
}

async function renewClaims(input = {}, db) {
  const ids = claimIds(input.ids);
  const owner = leaseOwner(input.owner);
  const leaseMs = boundedInteger(
    input.leaseMs, 'lease duration', DEFAULT_LEASE_MS, 1_000, 10 * 60 * 1_000
  );
  const { rows } = await runner(db).query(
    `UPDATE telegram_alert_deliveries
     SET lease_until = NOW() + ($3::int * INTERVAL '1 millisecond'),
         updated_at = NOW()
     WHERE id = ANY($1::bigint[])
       AND status = 'claimed'
       AND lease_owner = $2
       AND lease_until > NOW()
     RETURNING *`,
    [ids, owner, leaseMs]
  );
  return rows.map(mapRow);
}

async function settleClaim(input, status, db) {
  const value = normalizeSettlement(input, status);
  const { rows } = await runner(db).query(
    `UPDATE telegram_alert_deliveries
     SET status = $3::varchar(16),
         next_attempt_at = CASE
           WHEN $3::varchar(16) = 'retry' THEN $4::timestamptz
           ELSE next_attempt_at
         END,
         lease_owner = NULL,
         lease_until = NULL,
         telegram_message_id = $5::bigint,
         telegram_file_id = $6,
         last_error_code = $7,
         last_error = $8,
         delivered_at = CASE WHEN $3::varchar(16) = 'sent' THEN NOW() ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'claimed'
       AND lease_owner = $2
       AND lease_until > NOW()
     RETURNING *`,
    [
      value.id,
      value.owner,
      value.status,
      value.nextAttemptAt,
      value.messageId,
      value.fileId,
      value.errorCode,
      value.error,
    ]
  );
  return mapRow(rows[0]);
}

function markSent(input, db) {
  return settleClaim(input, 'sent', db);
}

function scheduleRetry(input, db) {
  return settleClaim(input, 'retry', db);
}

function markFailed(input, db) {
  return settleClaim(input, 'failed', db);
}

function cancelClaim(input, db) {
  return settleClaim(input, 'cancelled', db);
}

module.exports = {
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_LEASE_MS,
  TelegramAlertDeliveryConflictError,
  cancelClaim,
  claimReadyBatch,
  createPending,
  markFailed,
  markSent,
  renewClaims,
  scheduleRetry,
};
