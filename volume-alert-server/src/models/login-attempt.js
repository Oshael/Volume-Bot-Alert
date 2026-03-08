const { query } = require('./db');

const LoginAttempt = {
  /**
   * Record a login attempt.
   */
  async record({ email, ipAddress, success, userAgent }) {
    await query(
      `INSERT INTO login_attempts (email, ip_address, success, user_agent)
       VALUES (LOWER($1), $2, $3, $4)`,
      [email, ipAddress, success, userAgent || null]
    );
  },

  /**
   * Count failed attempts from an IP in the last N minutes.
   */
  async countFailedByIp(ipAddress, minutes = 15) {
    const { rows } = await query(
      `SELECT COUNT(*) as count FROM login_attempts
       WHERE ip_address = $1 AND success = false
       AND created_at > NOW() - INTERVAL '1 minute' * $2`,
      [ipAddress, minutes]
    );
    return parseInt(rows[0].count);
  },

  /**
   * Count failed attempts for an email in the last N minutes.
   */
  async countFailedByEmail(email, minutes = 15) {
    const { rows } = await query(
      `SELECT COUNT(*) as count FROM login_attempts
       WHERE email = LOWER($1) AND success = false
       AND created_at > NOW() - INTERVAL '1 minute' * $2`,
      [email, minutes]
    );
    return parseInt(rows[0].count);
  },

  /**
   * Check if IP or email is currently locked out.
   * Returns { locked, reason, retryAfterSeconds } or { locked: false }.
   */
  async checkLockout(email, ipAddress) {
    const IP_LIMIT = 10;       // max failed attempts per IP
    const EMAIL_LIMIT = 5;     // max failed attempts per email
    const WINDOW_MIN = 15;     // time window in minutes
    const LOCKOUT_MIN = 15;    // lockout duration

    const [ipCount, emailCount] = await Promise.all([
      this.countFailedByIp(ipAddress, WINDOW_MIN),
      this.countFailedByEmail(email, WINDOW_MIN),
    ]);

    if (ipCount >= IP_LIMIT) {
      return {
        locked: true,
        reason: 'Too many failed attempts from this IP',
        retryAfterSeconds: LOCKOUT_MIN * 60,
      };
    }
    if (emailCount >= EMAIL_LIMIT) {
      return {
        locked: true,
        reason: 'Too many failed attempts for this account',
        retryAfterSeconds: LOCKOUT_MIN * 60,
      };
    }
    return { locked: false };
  },

  /**
   * Cleanup old attempts (older than 24h). Run periodically.
   */
  async cleanup() {
    const { rowCount } = await query(
      "DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '24 hours'"
    );
    return rowCount;
  },
};

module.exports = LoginAttempt;
