const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');
const {
  assertAutomaticAlertPublicationAuthorized,
} = require('../services/automatic-alert-publication-guard');

const VALID_STATUSES = new Set(['idle', 'triggered', 'rearmed']);

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

function normalizeIdentity(address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  return { chain, address: normalizeTokenAddress(chain, address) };
}

function assertAutomaticAlertsEnabled(chain, authorization) {
  if (chain === 'solana') return;
  assertAutomaticAlertPublicationAuthorized(authorization, chain);
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_STATUSES.has(normalized) ? normalized : 'idle';
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

function normalizeFingerprint(value) {
  const fingerprint = String(value || '').trim();
  return fingerprint ? fingerprint.slice(0, 255) : null;
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
    userId: Number(row.user_id) || null,
    ruleKey: row.rule_key || null,
    chain: row.chain || 'solana',
    tokenAddress: row.token_address || null,
    status: normalizeStatus(row.status),
    lastAlertedAt: row.last_alerted_at || null,
    lastAlertedValue: toNumberOrNull(row.last_alerted_value),
    lastAlertedPct: toNumberOrNull(row.last_alerted_pct),
    cooldownUntil: row.cooldown_until || null,
    rearmRequired: Boolean(row.rearm_required),
    lastFingerprint: normalizeFingerprint(row.last_fingerprint),
    metadata: normalizeMetadata(row.metadata),
    updatedAt: row.updated_at || null,
  };
}

async function getState(userId, ruleKey, tokenAddress, runner = db, chainValue = 'solana') {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedRuleKey = normalizeRuleKey(ruleKey);
  const identity = normalizeIdentity(tokenAddress, chainValue);

  const { rows } = await runner.query(
    `SELECT *
     FROM user_alert_rule_state
     WHERE user_id = $1
       AND rule_key = $2
       AND chain = $3
       AND token_address = $4
     LIMIT 1`,
    [normalizedUserId, normalizedRuleKey, identity.chain, identity.address]
  );

  return mapStateRow(rows[0] || null);
}

async function listStatesByUsersForToken(input = {}, runner = db) {
  const userIds = [...new Set((Array.isArray(input.userIds) ? input.userIds : [])
    .map((userId) => normalizeUserId(userId)))];
  const ruleKeys = [...new Set((Array.isArray(input.ruleKeys) ? input.ruleKeys : [])
    .map((ruleKey) => normalizeRuleKey(ruleKey)))];
  const identity = normalizeIdentity(input.tokenAddress, input.chain || 'solana');
  if (!userIds.length || !ruleKeys.length) return [];
  const { rows } = await runner.query(
    `SELECT *
     FROM user_alert_rule_state
     WHERE user_id = ANY($1::bigint[])
       AND rule_key = ANY($2::text[])
       AND chain = $3
       AND token_address = $4
     ORDER BY user_id, rule_key`,
    [userIds, ruleKeys, identity.chain, identity.address]
  );
  return rows.map(mapStateRow);
}

async function upsertState(payload = {}, runner = db) {
  const userId = normalizeUserId(payload.userId);
  const ruleKey = normalizeRuleKey(payload.ruleKey);
  const identity = normalizeIdentity(payload.tokenAddress, payload.chain || 'solana');
  assertAutomaticAlertsEnabled(identity.chain, payload.authorization);
  const status = normalizeStatus(payload.status);
  const lastAlertedAt = toTimestampOrNull(payload.lastAlertedAt);
  const lastAlertedValue = toNumberOrNull(payload.lastAlertedValue);
  const lastAlertedPct = toNumberOrNull(payload.lastAlertedPct);
  const cooldownUntil = toTimestampOrNull(payload.cooldownUntil);
  const rearmRequired = Boolean(payload.rearmRequired);
  const lastFingerprint = normalizeFingerprint(payload.lastFingerprint);
  const metadata = normalizeMetadata(payload.metadata);

  const { rows } = await runner.query(
    `INSERT INTO user_alert_rule_state (
       user_id,
       rule_key,
       chain,
       token_address,
       status,
       last_alerted_at,
       last_alerted_value,
       last_alerted_pct,
       cooldown_until,
       rearm_required,
       last_fingerprint,
       metadata,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
     ON CONFLICT (user_id, rule_key, chain, token_address) DO UPDATE SET
       status = EXCLUDED.status,
       last_alerted_at = EXCLUDED.last_alerted_at,
       last_alerted_value = EXCLUDED.last_alerted_value,
       last_alerted_pct = EXCLUDED.last_alerted_pct,
       cooldown_until = EXCLUDED.cooldown_until,
       rearm_required = EXCLUDED.rearm_required,
       last_fingerprint = EXCLUDED.last_fingerprint,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      userId,
      ruleKey,
      identity.chain,
      identity.address,
      status,
      lastAlertedAt,
      lastAlertedValue,
      lastAlertedPct,
      cooldownUntil,
      rearmRequired,
      lastFingerprint,
      JSON.stringify(metadata),
    ]
  );

  return mapStateRow(rows[0] || null);
}

async function markTriggered(payload = {}, runner = db) {
  return upsertState({
    userId: payload.userId,
    ruleKey: payload.ruleKey,
    chain: payload.chain,
    tokenAddress: payload.tokenAddress,
    status: 'triggered',
    lastAlertedAt: payload.lastAlertedAt,
    lastAlertedValue: payload.lastAlertedValue,
    lastAlertedPct: payload.lastAlertedPct,
    cooldownUntil: payload.cooldownUntil,
    rearmRequired: payload.rearmRequired == null ? true : payload.rearmRequired,
    lastFingerprint: payload.lastFingerprint,
    metadata: payload.metadata,
    authorization: payload.authorization,
  }, runner);
}

async function markRearmed(payload = {}, runner = db) {
  const chain = payload.chain || 'solana';
  assertAutomaticAlertsEnabled(normalizeTokenChain(chain), payload.authorization);
  const current = await getState(payload.userId, payload.ruleKey, payload.tokenAddress, runner, chain);
  const cooldownUntil = toTimestampOrNull(payload.cooldownUntil) || null;
  return upsertState({
    userId: payload.userId,
    ruleKey: payload.ruleKey,
    chain,
    tokenAddress: payload.tokenAddress,
    status: 'rearmed',
    lastAlertedAt: current?.lastAlertedAt,
    lastAlertedValue: current?.lastAlertedValue,
    lastAlertedPct: current?.lastAlertedPct,
    cooldownUntil,
    rearmRequired: false,
    lastFingerprint: payload.lastFingerprint ?? current?.lastFingerprint ?? null,
    metadata: payload.metadata ?? current?.metadata ?? {},
    authorization: payload.authorization,
  }, runner);
}

module.exports = {
  VALID_STATUSES,
  getState,
  listStatesByUsersForToken,
  markRearmed,
  markTriggered,
  upsertState,
  __private: {
    mapStateRow,
    normalizeIdentity,
    normalizeFingerprint,
    normalizeMetadata,
    normalizeRuleKey,
    normalizeStatus,
    normalizeUserId,
    toNumberOrNull,
    toTimestampOrNull,
  },
};
