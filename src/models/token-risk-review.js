const db = require('./db');
const { isValidAddress } = require('./user-token');

const VALID_LABELS = new Set([
  'valid',
  'valid_but_weak',
  'junk_probable',
  'junk_permanent',
]);
const VALID_SOURCES = new Set([
  'manual',
  'auto',
]);

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!isValidAddress(value)) {
    throw new Error('Invalid token address format');
  }
  return value;
}

function normalizeLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (!VALID_LABELS.has(normalized)) {
    throw new Error('Invalid token risk label');
  }
  return normalized;
}

function normalizeNotes(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 5000) : null;
}

function normalizeSource(value, fallback = 'manual') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!VALID_SOURCES.has(normalized)) {
    throw new Error('Invalid token risk review source');
  }
  return normalized;
}

function toPositiveIntegerOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function mapRow(row) {
  if (!row) return null;
  return {
    tokenAddress: row.token_address || null,
    label: row.label || null,
    source: normalizeSource(row.source, 'manual'),
    notes: normalizeNotes(row.notes),
    createdBy: toPositiveIntegerOrNull(row.created_by),
    updatedBy: toPositiveIntegerOrNull(row.updated_by),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getByAddress(address, runner = db) {
  const tokenAddress = normalizeAddress(address);
  const { rows } = await runner.query(
    `SELECT *
     FROM token_risk_reviews
     WHERE token_address = $1
     LIMIT 1`,
    [tokenAddress]
  );

  return mapRow(rows[0] || null);
}

async function listByAddresses(addresses = [], runner = db) {
  const normalized = [...new Set((addresses || []).map((address) => String(address || '').trim()).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }

  for (const address of normalized) {
    if (!isValidAddress(address)) {
      throw new Error('Invalid token address format');
    }
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM token_risk_reviews
     WHERE token_address = ANY($1::varchar[])
     ORDER BY token_address ASC`,
    [normalized]
  );

  return rows.map(mapRow);
}

async function upsertReview(payload = {}, runner = db) {
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const label = normalizeLabel(payload.label);
  const source = normalizeSource(payload.source, 'manual');
  const notes = normalizeNotes(payload.notes);
  const createdBy = toPositiveIntegerOrNull(payload.createdBy);
  const updatedBy = toPositiveIntegerOrNull(payload.updatedBy) || createdBy;

  const { rows } = await runner.query(
    `INSERT INTO token_risk_reviews (
       token_address,
       label,
       source,
       notes,
       created_by,
       updated_by,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (token_address) DO UPDATE SET
       label = EXCLUDED.label,
       source = EXCLUDED.source,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      tokenAddress,
      label,
      source,
      notes,
      createdBy,
      updatedBy,
    ]
  );

  return mapRow(rows[0] || null);
}

async function upsertAutoReview(payload = {}, runner = db) {
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const label = normalizeLabel(payload.label === 'junk_permanent' ? 'junk_probable' : payload.label);
  const notes = normalizeNotes(payload.notes);

  const { rows } = await runner.query(
    `INSERT INTO token_risk_reviews (
       token_address,
       label,
       source,
       notes,
       created_by,
       updated_by,
       created_at,
       updated_at
     )
     VALUES ($1, $2, 'auto', $3, NULL, NULL, NOW(), NOW())
     ON CONFLICT (token_address) DO UPDATE SET
       label = CASE
         WHEN token_risk_reviews.source = 'manual' THEN token_risk_reviews.label
         ELSE EXCLUDED.label
       END,
       source = CASE
         WHEN token_risk_reviews.source = 'manual' THEN token_risk_reviews.source
         ELSE EXCLUDED.source
       END,
       notes = CASE
         WHEN token_risk_reviews.source = 'manual' THEN token_risk_reviews.notes
         ELSE EXCLUDED.notes
       END,
       updated_by = CASE
         WHEN token_risk_reviews.source = 'manual' THEN token_risk_reviews.updated_by
         ELSE NULL
       END,
       updated_at = CASE
         WHEN token_risk_reviews.source = 'manual' THEN token_risk_reviews.updated_at
         ELSE NOW()
       END
     RETURNING *`,
    [
      tokenAddress,
      label,
      notes,
    ]
  );

  return mapRow(rows[0] || null);
}

async function remove(address, runner = db) {
  const tokenAddress = normalizeAddress(address);
  const result = await runner.query(
    'DELETE FROM token_risk_reviews WHERE token_address = $1',
    [tokenAddress]
  );
  return (result.rowCount || 0) > 0;
}

module.exports = {
  VALID_LABELS,
  VALID_SOURCES,
  getByAddress,
  listByAddresses,
  upsertReview,
  upsertAutoReview,
  remove,
  __private: {
    mapRow,
    normalizeAddress,
    normalizeLabel,
    normalizeNotes,
    normalizeSource,
    toPositiveIntegerOrNull,
  },
};
