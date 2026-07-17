const db = require('./db');
const adminBlockEvidence = require('./admin-block-evidence');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

let ensureTablePromise = null;

function ensureTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS admin_blocked_tokens (
        chain VARCHAR(16) NOT NULL DEFAULT 'solana',
        address VARCHAR(64) NOT NULL,
        label VARCHAR(128),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT admin_blocked_tokens_chain_pkey PRIMARY KEY (chain, address)
      );

      ALTER TABLE admin_blocked_tokens
        ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana';

      DO $index$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'admin_blocked_tokens_chain_pkey'
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_blocked_tokens_chain_address
            ON admin_blocked_tokens(chain, address);
        END IF;
      END
      $index$;

      CREATE INDEX IF NOT EXISTS idx_admin_blocked_tokens_created_at
        ON admin_blocked_tokens(created_at DESC);
    `);
  }

  return ensureTablePromise;
}

function normalizeIdentity(address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  return { chain, address: normalizeTokenAddress(chain, address) };
}

function normalizeLabel(label) {
  return label == null ? null : String(label).trim() || null;
}

function isAutomaticBlockRequest(createdBy) {
  return createdBy == null || String(createdBy).trim() === '';
}

function buildProtectedAutoBlockError(identity, protection) {
  const { chain, address } = identity;
  const err = new Error(`Automatic admin block prevented for protected token ${address}`);
  err.code = 'PROTECTED_RISK_REVIEW_AUTO_BLOCK';
  err.tokenAddress = address;
  err.chain = chain;
  err.riskReviewLabel = protection?.label || null;
  err.riskReviewSource = protection?.source || null;
  return err;
}

async function getAutoBlockProtection(identity) {
  const { rows } = await db.query(
    `SELECT label, source
     FROM token_risk_reviews
     WHERE chain = $1 AND token_address = $2
     LIMIT 1`,
    [identity.chain, identity.address]
  );
  const row = rows[0] || null;
  const label = String(row?.label || '').trim().toLowerCase();
  const source = String(row?.source || '').trim().toLowerCase();
  if (label === 'valid' || source === 'manual') {
    return { label, source };
  }
  return null;
}

async function captureEvidenceSafely({ identity, label, createdBy, evidence }) {
  if (!evidence || typeof evidence !== 'object') {
    return null;
  }
  try {
    return await adminBlockEvidence.createEvidence({
      ...evidence,
      chain: identity.chain,
      tokenAddress: identity.address,
      banLabel: label,
      createdBy,
    });
  } catch (err) {
    console.error(`[AdminBlockedToken] Failed to capture block evidence for ${identity.chain}:${identity.address}:`, err.message);
    return null;
  }
}

function shouldAllowProtectedAutoBlock(protection, options = {}) {
  return protection?.source !== 'manual'
    && protection?.label === 'valid'
    && options.allowAutoValidOverride === true;
}

async function add({
  chain = 'solana',
  address,
  label = null,
  createdBy = null,
  evidence = null,
  allowAutoValidOverride = false,
}) {
  await ensureTable();
  const identity = normalizeIdentity(address, chain);

  if (isAutomaticBlockRequest(createdBy)) {
    const protection = await getAutoBlockProtection(identity);
    if (protection && !shouldAllowProtectedAutoBlock(protection, { allowAutoValidOverride })) {
      throw buildProtectedAutoBlockError(identity, protection);
    }
  }

  const { rows } = await db.query(
    `INSERT INTO admin_blocked_tokens (chain, address, label, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chain, address) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, admin_blocked_tokens.label)
     RETURNING *`,
    [identity.chain, identity.address, normalizeLabel(label), createdBy || null]
  );

  await captureEvidenceSafely({
    identity,
    label: normalizeLabel(label),
    createdBy: createdBy || null,
    evidence,
  });

  return rows[0] || null;
}

async function remove(address, chainValue = 'solana') {
  await ensureTable();
  const identity = normalizeIdentity(address, chainValue);
  const { rowCount } = await db.query(
    'DELETE FROM admin_blocked_tokens WHERE chain = $1 AND address = $2',
    [identity.chain, identity.address]
  );
  return rowCount > 0;
}

async function hasAddress(address, chainValue = 'solana') {
  await ensureTable();
  const identity = normalizeIdentity(address, chainValue);
  const { rows } = await db.query(
    'SELECT 1 FROM admin_blocked_tokens WHERE chain = $1 AND address = $2 LIMIT 1',
    [identity.chain, identity.address]
  );
  return rows.length > 0;
}

async function listByAddresses(addresses = [], chainValue = 'solana') {
  await ensureTable();
  const chain = normalizeTokenChain(chainValue);
  const normalized = [...new Set(addresses.map((address) => {
    try { return normalizeTokenAddress(chain, address); } catch (_) { return null; }
  }).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }

  const { rows } = await db.query(
    `SELECT chain, address, label, created_by, created_at
     FROM admin_blocked_tokens
     WHERE chain = $1 AND address = ANY($2::varchar[])`,
    [chain, normalized]
  );
  return rows;
}

async function listAddressesWithCleanupArtifacts(limit = 50, options = {}) {
  await ensureTable();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const minBlockedAgeMs = Math.max(0, Number(options.minBlockedAgeMs) || 0);
  const { rows } = await db.query(
    `SELECT ab.address
     FROM admin_blocked_tokens ab
     LEFT JOIN token_risk_reviews trr
       ON trr.chain = ab.chain
      AND trr.token_address = ab.address
     WHERE ab.chain = 'solana'
       AND ab.created_at <= NOW() - ($2 * INTERVAL '1 millisecond')
       AND COALESCE(LOWER(trr.label), '') <> 'valid'
       AND COALESCE(LOWER(trr.source), '') <> 'manual'
       AND (
         EXISTS (
           SELECT 1
           FROM token_market_buckets_1m buckets
           WHERE buckets.chain = ab.chain AND buckets.token_address = ab.address
           LIMIT 1
         )
         OR EXISTS (
           SELECT 1
           FROM token_market_buckets_agg buckets
           WHERE buckets.chain = ab.chain AND buckets.token_address = ab.address
           LIMIT 1
         )
         OR EXISTS (
           SELECT 1
           FROM token_market_volume_buckets_1m buckets
           WHERE buckets.chain = ab.chain AND buckets.token_address = ab.address
           LIMIT 1
         )
         OR EXISTS (
           SELECT 1
           FROM token_meteora_snapshots snapshots
           WHERE ab.chain = 'solana' AND snapshots.token_address = ab.address
           LIMIT 1
         )
       )
     ORDER BY ab.created_at ASC, ab.address ASC
     LIMIT $1`,
    [safeLimit, minBlockedAgeMs]
  );
  return rows.map((row) => row.address).filter(Boolean);
}

module.exports = {
  ensureTable,
  add,
  remove,
  hasAddress,
  listByAddresses,
  listAddressesWithCleanupArtifacts,
  __private: {
    buildProtectedAutoBlockError,
    captureEvidenceSafely,
    getAutoBlockProtection,
    isAutomaticBlockRequest,
    normalizeIdentity,
    normalizeLabel,
  },
};
