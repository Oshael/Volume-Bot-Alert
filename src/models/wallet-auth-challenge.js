const crypto = require('crypto');
const db = require('./db');
const userWallet = require('./user-wallet');

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function generateNonce() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeMessage(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw Object.assign(new Error('Challenge message is required'), { status: 400 });
  }
  return normalized;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    nonceHash: row.nonce_hash,
    messageHash: row.message_hash,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    ipAddress: row.ip_address || null,
    userAgent: row.user_agent || null,
  };
}

async function create(input = {}, runner = db) {
  const nonce = String(input.nonce || '').trim() || generateNonce();
  const message = normalizeMessage(input.message);
  const { rows } = await runner.query(
    `INSERT INTO wallet_auth_challenges (
       wallet_address,
       nonce_hash,
       message_hash,
       issued_at,
       expires_at,
       ip_address,
       user_agent
     )
     VALUES ($1, $2, $3, COALESCE($4, NOW()), $5, $6, $7)
     RETURNING *`,
    [
      userWallet.normalizeWalletAddress(input.walletAddress),
      hashValue(nonce),
      hashValue(message),
      input.issuedAt || null,
      input.expiresAt,
      input.ipAddress || null,
      input.userAgent || null,
    ]
  );

  return {
    nonce,
    record: mapRow(rows[0]),
  };
}

async function findValidByNonce(walletAddress, nonce, runner = db) {
  const { rows } = await runner.query(
    `SELECT *
     FROM wallet_auth_challenges
     WHERE wallet_address = $1
       AND nonce_hash = $2
       AND consumed_at IS NULL
       AND expires_at > NOW()
     ORDER BY issued_at DESC
     LIMIT 1`,
    [userWallet.normalizeWalletAddress(walletAddress), hashValue(nonce)]
  );
  return mapRow(rows[0]);
}

async function findValidByMessage(walletAddress, message, runner = db) {
  const { rows } = await runner.query(
    `SELECT *
     FROM wallet_auth_challenges
     WHERE wallet_address = $1
       AND message_hash = $2
       AND consumed_at IS NULL
       AND expires_at > NOW()
     ORDER BY issued_at DESC
     LIMIT 1`,
    [userWallet.normalizeWalletAddress(walletAddress), hashValue(message)]
  );
  return mapRow(rows[0]);
}

async function consume(id, runner = db) {
  const { rows } = await runner.query(
    `UPDATE wallet_auth_challenges
     SET consumed_at = NOW()
     WHERE id = $1
       AND consumed_at IS NULL
     RETURNING *`,
    [id]
  );
  return mapRow(rows[0]);
}

async function cleanupExpired(runner = db) {
  const { rowCount } = await runner.query(
    `DELETE FROM wallet_auth_challenges
     WHERE consumed_at IS NOT NULL
        OR expires_at < NOW()`
  );
  return rowCount;
}

module.exports = {
  hashValue,
  generateNonce,
  mapRow,
  create,
  findValidByNonce,
  findValidByMessage,
  consume,
  cleanupExpired,
};
