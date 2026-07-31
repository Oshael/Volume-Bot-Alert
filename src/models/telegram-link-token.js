const crypto = require('node:crypto');
const { query } = require('./db');

const runner = (db) => (db && typeof db.query === 'function' ? db : { query });
const hashToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('base64url');

async function create({ userId, expiresAt, token }, db) {
  const rawToken = String(token || '').trim() || generateToken();
  const { rows } = await runner(db).query(
    `INSERT INTO telegram_link_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, expires_at, created_at`,
    [userId, hashToken(rawToken), expiresAt]
  );
  return { token: rawToken, record: rows[0] || null };
}

async function consume(token, db) {
  const { rows } = await runner(db).query(
    `UPDATE telegram_link_tokens
     SET consumed_at = NOW()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING id, user_id, expires_at, consumed_at, created_at`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function revokeForUser(userId, db) {
  const { rowCount } = await runner(db).query(
    `UPDATE telegram_link_tokens
     SET consumed_at = NOW()
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId]
  );
  return rowCount;
}

module.exports = { consume, create, generateToken, hashToken, revokeForUser };
