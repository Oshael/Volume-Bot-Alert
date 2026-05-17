const db = require('./db');
const { isValidAddress } = require('./user-token');

let ensureTablePromise = null;

function ensureTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS admin_block_evidence (
        id SERIAL PRIMARY KEY,
        token_address VARCHAR(64) NOT NULL,
        ban_label VARCHAR(160),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        pipeline VARCHAR(64) NOT NULL,
        source VARCHAR(64),
        catalog_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        market_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        risk_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        meteora_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        gmgn_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
        rule_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_block_evidence_token_created
        ON admin_block_evidence(token_address, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_admin_block_evidence_pipeline_created
        ON admin_block_evidence(pipeline, created_at DESC, id DESC);
    `);
  }

  return ensureTablePromise;
}

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!isValidAddress(value)) {
    throw new Error('Invalid token address format');
  }
  return value;
}

function normalizeText(value, maxLength = 160) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || null,
    tokenAddress: row.token_address || null,
    banLabel: row.ban_label || null,
    createdBy: row.created_by || null,
    pipeline: row.pipeline || null,
    source: row.source || null,
    catalogSnapshot: row.catalog_snapshot || {},
    marketSnapshot: row.market_snapshot || {},
    riskSnapshot: row.risk_snapshot || {},
    meteoraSnapshot: row.meteora_snapshot || {},
    gmgnSnapshot: row.gmgn_snapshot || {},
    assessment: row.assessment || {},
    ruleMatches: row.rule_matches || [],
    createdAt: row.created_at || null,
  };
}

async function createEvidence(payload = {}, runner = db) {
  await ensureTable();
  const tokenAddress = normalizeAddress(payload.tokenAddress || payload.address);
  const pipeline = normalizeText(payload.pipeline, 64);
  if (!pipeline) {
    throw new Error('Admin block evidence pipeline is required');
  }

  const { rows } = await runner.query(
    `INSERT INTO admin_block_evidence (
       token_address,
       ban_label,
       created_by,
       pipeline,
       source,
       catalog_snapshot,
       market_snapshot,
       risk_snapshot,
       meteora_snapshot,
       gmgn_snapshot,
       assessment,
       rule_matches,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, NOW())
     RETURNING *`,
    [
      tokenAddress,
      normalizeText(payload.banLabel || payload.label, 160),
      payload.createdBy || null,
      pipeline,
      normalizeText(payload.source, 64),
      JSON.stringify(normalizeJsonObject(payload.catalogSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.marketSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.riskSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.meteoraSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.gmgnSnapshot)),
      JSON.stringify(normalizeJsonObject(payload.assessment)),
      JSON.stringify(normalizeJsonArray(payload.ruleMatches)),
    ]
  );

  return mapRow(rows[0] || null);
}

module.exports = {
  ensureTable,
  createEvidence,
  __private: {
    mapRow,
    normalizeAddress,
    normalizeJsonArray,
    normalizeJsonObject,
    normalizeText,
  },
};
