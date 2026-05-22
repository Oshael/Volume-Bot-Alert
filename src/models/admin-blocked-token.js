const db = require('./db');
const { isValidAddress } = require('./user-token');
const adminBlockEvidence = require('./admin-block-evidence');

let ensureTablePromise = null;

function ensureTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS admin_blocked_tokens (
        address VARCHAR(64) PRIMARY KEY,
        label VARCHAR(128),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_blocked_tokens_created_at
        ON admin_blocked_tokens(created_at DESC);
    `);
  }

  return ensureTablePromise;
}

function normalizeAddress(address) {
  return String(address || '').trim();
}

function normalizeLabel(label) {
  return label == null ? null : String(label).trim() || null;
}

async function captureEvidenceSafely({ address, label, createdBy, evidence }) {
  if (!evidence || typeof evidence !== 'object') {
    return null;
  }
  try {
    return await adminBlockEvidence.createEvidence({
      ...evidence,
      tokenAddress: address,
      banLabel: label,
      createdBy,
    });
  } catch (err) {
    console.error(`[AdminBlockedToken] Failed to capture block evidence for ${address}:`, err.message);
    return null;
  }
}

async function add({ address, label = null, createdBy = null, evidence = null }) {
  await ensureTable();
  const normalizedAddress = normalizeAddress(address);
  if (!isValidAddress(normalizedAddress)) {
    throw new Error('Invalid token address');
  }

  const { rows } = await db.query(
    `INSERT INTO admin_blocked_tokens (address, label, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, admin_blocked_tokens.label)
     RETURNING *`,
    [normalizedAddress, normalizeLabel(label), createdBy || null]
  );

  await captureEvidenceSafely({
    address: normalizedAddress,
    label: normalizeLabel(label),
    createdBy: createdBy || null,
    evidence,
  });

  return rows[0] || null;
}

async function remove(address) {
  await ensureTable();
  const normalizedAddress = normalizeAddress(address);
  const { rowCount } = await db.query(
    'DELETE FROM admin_blocked_tokens WHERE address = $1',
    [normalizedAddress]
  );
  return rowCount > 0;
}

async function hasAddress(address) {
  await ensureTable();
  const normalizedAddress = normalizeAddress(address);
  const { rows } = await db.query(
    'SELECT 1 FROM admin_blocked_tokens WHERE address = $1 LIMIT 1',
    [normalizedAddress]
  );
  return rows.length > 0;
}

async function listByAddresses(addresses = []) {
  await ensureTable();
  const normalized = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }

  const { rows } = await db.query(
    'SELECT address, label, created_by, created_at FROM admin_blocked_tokens WHERE address = ANY($1::varchar[])',
    [normalized]
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
     WHERE ab.created_at <= NOW() - ($2 * INTERVAL '1 millisecond')
       AND (
         EXISTS (
           SELECT 1
           FROM token_market_buckets_1m buckets
           WHERE buckets.token_address = ab.address
           LIMIT 1
         )
         OR EXISTS (
           SELECT 1
           FROM token_market_buckets_agg buckets
           WHERE buckets.token_address = ab.address
           LIMIT 1
         )
         OR EXISTS (
           SELECT 1
           FROM token_market_volume_buckets_1m buckets
           WHERE buckets.token_address = ab.address
           LIMIT 1
         )
         OR EXISTS (
           SELECT 1
           FROM token_meteora_snapshots snapshots
           WHERE snapshots.token_address = ab.address
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
    captureEvidenceSafely,
    normalizeAddress,
    normalizeLabel,
  },
};
