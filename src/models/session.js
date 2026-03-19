const crypto = require('crypto');
const { query } = require('./db');

function getExecutor(db) {
  return db && typeof db.query === 'function' ? db : { query };
}

const Session = {
  /**
   * Create a session record. Stores a hash of the JWT (not the JWT itself).
   */
  async create({ userId, token, ipAddress, userAgent, expiresAt }, db) {
    const executor = getExecutor(db);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await executor.query(
      `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, tokenHash, ipAddress, userAgent || null, expiresAt]
    );
    return rows[0];
  },

  /**
   * Check if a session is still valid (not revoked/expired).
   */
  async isValid(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await query(
      `SELECT id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()`,
      [tokenHash]
    );
    return rows.length > 0;
  },

  /**
   * Revoke a specific session (logout).
   */
  async revoke(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  },

  /**
   * Revoke all sessions for a user (force logout everywhere).
   */
  async revokeAllForUser(userId) {
    const { rowCount } = await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return rowCount;
  },

  /**
   * Clean up expired sessions (run periodically).
   */
  async cleanup() {
    const { rowCount } = await query('DELETE FROM sessions WHERE expires_at < NOW()');
    return rowCount;
  },
};

module.exports = Session;
