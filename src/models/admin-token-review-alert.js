const db = require('./db');
const { isValidAddress } = require('./user-token');

let ensureTablePromise = null;

function ensureTable() {
  if (!ensureTablePromise) {
    const { STATEMENTS } = require('../utils/db-init-stage46');
    ensureTablePromise = (async () => {
      for (const statement of STATEMENTS) {
        await db.query(statement);
      }
    })();
  }
  return ensureTablePromise;
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }
  return address;
}

function normalizeText(value, fallback, maxLength = 160) {
  const normalized = String(value || fallback || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeStatus(value, fallback = 'open') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return ['open', 'resolved'].includes(normalized) ? normalized : fallback;
}

function normalizeResolution(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!['dismiss', 'block', 'mark_valid', 'mark_weak'].includes(normalized)) {
    throw new Error('Invalid admin token review resolution');
  }
  return normalized;
}

function normalizeLimit(value, fallback = 50) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}

function normalizeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || null,
    tokenAddress: row.token_address || null,
    status: row.status || null,
    priority: row.priority || null,
    alertKind: row.alert_kind || null,
    pipeline: row.pipeline || null,
    label: row.label || null,
    reasonCodes: normalizeJsonArray(row.reason_codes),
    assessment: normalizeJsonObject(row.assessment),
    socialSnapshot: normalizeJsonObject(row.social_snapshot),
    marketSnapshot: normalizeJsonObject(row.market_snapshot),
    riskSnapshot: normalizeJsonObject(row.risk_snapshot),
    meteoraSnapshot: normalizeJsonObject(row.meteora_snapshot),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    resolvedAt: row.resolved_at || null,
    resolvedBy: row.resolved_by || null,
    resolution: row.resolution || null,
    notes: row.notes || null,
  };
}

async function enqueue(payload = {}, runner = db) {
  await ensureTable();
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const alertKind = normalizeText(payload.alertKind, 'manual-review-socials-present', 64);
  const priority = normalizeText(payload.priority, 'normal', 24);
  const pipeline = normalizeText(payload.pipeline, 'unknown', 64);

  const { rows } = await runner.query(
    `INSERT INTO admin_token_review_alerts (
       token_address,
       status,
       priority,
       alert_kind,
       pipeline,
       label,
       reason_codes,
       assessment,
       social_snapshot,
       market_snapshot,
       risk_snapshot,
       meteora_snapshot,
       notes,
       created_at,
       updated_at
     )
     VALUES ($1, 'open', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, NOW(), NOW())
     ON CONFLICT (token_address, alert_kind) WHERE status = 'open'
     DO UPDATE SET
       priority = EXCLUDED.priority,
       pipeline = EXCLUDED.pipeline,
       label = COALESCE(EXCLUDED.label, admin_token_review_alerts.label),
       reason_codes = EXCLUDED.reason_codes,
       assessment = EXCLUDED.assessment,
       social_snapshot = EXCLUDED.social_snapshot,
       market_snapshot = EXCLUDED.market_snapshot,
       risk_snapshot = EXCLUDED.risk_snapshot,
       meteora_snapshot = EXCLUDED.meteora_snapshot,
       notes = COALESCE(EXCLUDED.notes, admin_token_review_alerts.notes),
       updated_at = NOW()
     RETURNING *`,
    [
      tokenAddress,
      priority,
      alertKind,
      pipeline,
      normalizeText(payload.label, null, 160),
      JSON.stringify(normalizeJsonArray(payload.reasonCodes)),
      JSON.stringify(normalizeJsonObject(payload.assessment)),
      JSON.stringify(normalizeJsonObject(payload.socialSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.marketSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.riskSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.meteoraSnapshot)),
      normalizeText(payload.notes, null, 1000),
    ]
  );

  return mapRow(rows[0] || null);
}

async function listRecent(filters = {}, runner = db) {
  await ensureTable();
  const values = [];
  const clauses = [];
  const status = normalizeStatus(filters.status, 'open');
  values.push(status);
  clauses.push(`status = $${values.length}`);

  if (filters.address) {
    values.push(normalizeAddress(filters.address));
    clauses.push(`token_address = $${values.length}`);
  }

  const limit = normalizeLimit(filters.limit);
  values.push(limit);
  const { rows } = await runner.query(
    `SELECT *
     FROM admin_token_review_alerts
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       created_at DESC,
       id DESC
     LIMIT $${values.length}`,
    values
  );

  return rows.map(mapRow);
}

async function getById(id, runner = db) {
  await ensureTable();
  const parsedId = Number.parseInt(String(id ?? ''), 10);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    throw new Error('Invalid admin token review alert id');
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM admin_token_review_alerts
     WHERE id = $1
     LIMIT 1`,
    [parsedId]
  );
  return mapRow(rows[0] || null);
}

async function resolve(id, payload = {}, runner = db) {
  await ensureTable();
  const parsedId = Number.parseInt(String(id ?? ''), 10);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    throw new Error('Invalid admin token review alert id');
  }
  const resolution = normalizeResolution(payload.resolution);
  const resolvedBy = Number.parseInt(String(payload.resolvedBy ?? ''), 10);

  const { rows } = await runner.query(
    `UPDATE admin_token_review_alerts
     SET status = 'resolved',
         resolution = $2,
         resolved_by = CASE WHEN $3::integer > 0 THEN $3::integer ELSE resolved_by END,
         resolved_at = NOW(),
         notes = COALESCE($4, notes),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'open'
     RETURNING *`,
    [
      parsedId,
      resolution,
      Number.isInteger(resolvedBy) && resolvedBy > 0 ? resolvedBy : null,
      normalizeText(payload.notes, null, 1000),
    ]
  );
  return mapRow(rows[0] || null);
}

module.exports = {
  ensureTable,
  enqueue,
  getById,
  listRecent,
  resolve,
  __private: {
    mapRow,
    normalizeAddress,
    normalizeJsonArray,
    normalizeJsonObject,
    normalizeLimit,
    normalizeResolution,
    normalizeStatus,
    normalizeText,
  },
};
