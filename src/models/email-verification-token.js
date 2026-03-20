const crypto = require('crypto');
const { query } = require('./db');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

const EmailVerificationToken = {
  hashToken,

  generateRawToken,

  async create({ userId, token, expiresAt, requestedIp = null, userAgent = null }) {
    const rawToken = String(token || '').trim() || generateRawToken();
    const tokenHash = hashToken(rawToken);

    const { rows } = await query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, requested_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, expires_at, created_at`,
      [userId, tokenHash, expiresAt, requestedIp, userAgent]
    );

    return {
      token: rawToken,
      record: rows[0] || null,
    };
  },

  async findValidByToken(token) {
    const tokenHash = hashToken(token);
    const { rows } = await query(
      `SELECT *
       FROM email_verification_tokens
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [tokenHash]
    );
    return rows[0] || null;
  },

  async consume(id) {
    const { rows } = await query(
      `UPDATE email_verification_tokens
       SET consumed_at = NOW()
       WHERE id = $1
         AND consumed_at IS NULL
       RETURNING *`,
      [id]
    );
    return rows[0] || null;
  },

  async revokeAllForUser(userId) {
    const { rowCount } = await query(
      `DELETE FROM email_verification_tokens
       WHERE user_id = $1`,
      [userId]
    );
    return rowCount;
  },

  async cleanupExpired() {
    const { rowCount } = await query(
      `DELETE FROM email_verification_tokens
       WHERE expires_at < NOW()
          OR consumed_at IS NOT NULL`
    );
    return rowCount;
  },
};

module.exports = EmailVerificationToken;
