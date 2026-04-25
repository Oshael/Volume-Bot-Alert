const db = require('./db');
const { isValidAddress } = require('./user-token');

const VALID_LABELS = new Set([
  'valid',
  'valid_but_weak',
  'junk_probable',
  'junk_permanent',
]);

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!isValidAddress(value)) {
    throw new Error('Invalid token address format');
  }
  return value;
}

function normalizeLabel(label) {
  const value = String(label || '').trim().toLowerCase();
  if (!VALID_LABELS.has(value)) {
    throw new Error('Invalid token junk evidence label');
  }
  return value;
}

function normalizeFingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Assessment fingerprint is required');
  }
  return normalized.slice(0, 64);
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
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
    id: toPositiveIntegerOrNull(row.id),
    tokenAddress: row.token_address || null,
    label: row.label || null,
    source: row.source || null,
    assessmentFingerprint: row.assessment_fingerprint || null,
    assessment: normalizeJsonObject(row.assessment),
    catalogSnapshot: normalizeJsonObject(row.catalog_snapshot),
    marketHistory: normalizeJsonObject(row.market_history),
    meteoraHistory: normalizeJsonObject(row.meteora_history),
    createdAt: row.created_at || null,
  };
}

async function hasFingerprint(address, fingerprint, runner = db) {
  const tokenAddress = normalizeAddress(address);
  const assessmentFingerprint = normalizeFingerprint(fingerprint);
  const { rows } = await runner.query(
    `SELECT 1
     FROM token_junk_evidence
     WHERE token_address = $1
       AND assessment_fingerprint = $2
     LIMIT 1`,
    [tokenAddress, assessmentFingerprint]
  );
  return rows.length > 0;
}

async function createEvidence(payload = {}, runner = db) {
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const label = normalizeLabel(payload.label);
  const source = String(payload.source || 'auto_sync').trim().toLowerCase() || 'auto_sync';
  const assessmentFingerprint = normalizeFingerprint(payload.assessmentFingerprint || payload.fingerprint);
  const assessment = normalizeJsonObject(payload.assessment);
  const catalogSnapshot = normalizeJsonObject(payload.catalogSnapshot);
  const marketHistory = normalizeJsonObject(payload.marketHistory);
  const meteoraHistory = normalizeJsonObject(payload.meteoraHistory);

  const { rows } = await runner.query(
    `INSERT INTO token_junk_evidence (
       token_address,
       label,
       source,
       assessment_fingerprint,
       assessment,
       catalog_snapshot,
       market_history,
       meteora_history,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
     ON CONFLICT (token_address, assessment_fingerprint) DO NOTHING
     RETURNING *`,
    [
      tokenAddress,
      label,
      source,
      assessmentFingerprint,
      JSON.stringify(assessment),
      JSON.stringify(catalogSnapshot),
      JSON.stringify(marketHistory),
      JSON.stringify(meteoraHistory),
    ]
  );

  return mapRow(rows[0] || null);
}

module.exports = {
  VALID_LABELS,
  hasFingerprint,
  createEvidence,
  __private: {
    mapRow,
    normalizeAddress,
    normalizeFingerprint,
    normalizeJsonObject,
    normalizeLabel,
    toPositiveIntegerOrNull,
  },
};
