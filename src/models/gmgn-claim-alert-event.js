const db = require('./db');
const { isValidAddress } = require('./user-token');
const { GMGN_CLAIM_SIGNAL_RULE_KEY } = require('../services/backend-alert-rules');

function normalizeRuleKey(value) {
  const normalized = String(value || GMGN_CLAIM_SIGNAL_RULE_KEY).trim().toLowerCase();
  if (!normalized) {
    throw new Error('Alert rule key is required');
  }
  if (normalized.length > 64) {
    throw new Error('Alert rule key must be 64 chars or less');
  }
  return normalized;
}

function normalizeTokenAddress(value) {
  const tokenAddress = String(value || '').trim();
  if (!isValidAddress(tokenAddress)) {
    throw new Error('Invalid token address format');
  }
  return tokenAddress;
}

function normalizeClaimId(value) {
  const claimId = String(value || '').trim();
  if (!claimId) {
    throw new Error('Claim id is required');
  }
  return claimId.slice(0, 255);
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
    signalType: Number(row.signal_type) || null,
    source: row.source || null,
    claimSequence: Number(row.claim_sequence) || null,
    claimId: row.claim_id || null,
    totalFeeUsd: toNumberOrNull(row.total_fee_usd),
    claimedAt: row.claimed_at || null,
    payload: normalizeMetadata(row.payload),
    isBaseline: row.is_baseline === true,
    triggeredAt: row.triggered_at || null,
    createdAt: row.created_at || null,
  };
}

async function listRecentEvents(filters = {}, runner = db) {
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const sort = String(filters.sort || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const values = [];
  const clauses = [];

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

  if (filters.includeBaseline !== true) {
    clauses.push('is_baseline = false');
  }

  values.push(limit);
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await runner.query(
    `SELECT *
     FROM gmgn_claim_alert_events
     ${whereClause}
     ORDER BY id ${sort}
     LIMIT $${values.length}`,
    values
  );

  return rows.map((row) => mapEventRow(row));
}

async function getLatestEventId(filters = {}, runner = db) {
  const values = [];
  const clauses = [];

  if (filters.ruleKey != null && String(filters.ruleKey).trim() !== '') {
    values.push(normalizeRuleKey(filters.ruleKey));
    clauses.push(`rule_key = $${values.length}`);
  }

  if (filters.tokenAddress != null && String(filters.tokenAddress).trim() !== '') {
    values.push(normalizeTokenAddress(filters.tokenAddress));
    clauses.push(`token_address = $${values.length}`);
  }

  if (filters.includeBaseline !== true) {
    clauses.push('is_baseline = false');
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await runner.query(
    `SELECT MAX(id) AS latest_id
     FROM gmgn_claim_alert_events
     ${whereClause}`,
    values
  );

  const latestId = Number(rows[0]?.latest_id);
  return Number.isFinite(latestId) && latestId > 0 ? latestId : null;
}

module.exports = {
  getLatestEventId,
  listRecentEvents,
  __private: {
    mapEventRow,
    normalizeClaimId,
    normalizeMetadata,
    normalizeRuleKey,
    normalizeTokenAddress,
    toNumberOrNull,
    toTimestampOrNull,
  },
};
