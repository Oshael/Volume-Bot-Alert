const db = require('./db');

function normalizeWalletAddress(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 64) {
    throw Object.assign(new Error('Invalid wallet address'), { status: 400 });
  }
  return normalized;
}

function normalizeChain(value) {
  const normalized = String(value || 'solana').trim().toLowerCase();
  if (normalized !== 'solana') {
    throw Object.assign(new Error('Unsupported wallet chain'), { status: 400 });
  }
  return normalized;
}

function normalizeStringOrNull(value, maxLength = 64) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    chain: row.chain,
    walletProvider: row.wallet_provider || null,
    isPrimary: Boolean(row.is_primary),
    linkedAt: row.linked_at ? new Date(row.linked_at).toISOString() : null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
    metadata: normalizeMetadata(row.metadata),
  };
}

async function createLink(input = {}, runner = db) {
  const { rows } = await runner.query(
    `INSERT INTO user_wallets (
       user_id,
       wallet_address,
       chain,
       wallet_provider,
       is_primary,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      input.userId,
      normalizeWalletAddress(input.walletAddress),
      normalizeChain(input.chain),
      normalizeStringOrNull(input.walletProvider),
      input.isPrimary !== false,
      JSON.stringify(normalizeMetadata(input.metadata)),
    ]
  );
  return mapRow(rows[0]);
}

async function findByWalletAddress(walletAddress, runner = db) {
  const { rows } = await runner.query(
    `SELECT *
     FROM user_wallets
     WHERE wallet_address = $1
     LIMIT 1`,
    [normalizeWalletAddress(walletAddress)]
  );
  return mapRow(rows[0]);
}

async function findByUserId(userId, runner = db) {
  const { rows } = await runner.query(
    `SELECT *
     FROM user_wallets
     WHERE user_id = $1
     ORDER BY linked_at DESC
     LIMIT 1`,
    [userId]
  );
  return mapRow(rows[0]);
}

async function markLastLogin(id, runner = db) {
  const { rows } = await runner.query(
    `UPDATE user_wallets
     SET last_login_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return mapRow(rows[0]);
}

async function markVerified(id, runner = db) {
  const { rows } = await runner.query(
    `UPDATE user_wallets
     SET last_verified_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return mapRow(rows[0]);
}

module.exports = {
  normalizeWalletAddress,
  mapRow,
  createLink,
  findByWalletAddress,
  findByUserId,
  markLastLogin,
  markVerified,
};
