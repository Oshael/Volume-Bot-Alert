const crypto = require('crypto');
const config = require('../../config');
const { query } = require('./db');

function getExecutor(db) {
  return db && typeof db.query === 'function' ? db : { query };
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeCodeLength(rawLength) {
  const parsedLength = Number.parseInt(rawLength, 10);
  if (!Number.isInteger(parsedLength)) {
    return 6;
  }
  return Math.max(4, parsedLength);
}

function randomCode(length = 6) {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += crypto.randomInt(0, 10).toString();
  }
  return code;
}

const LoginEmailOtpChallenge = {
  async create({ userId, expiresAt, requestedIp = null, userAgent = null }, db) {
    const executor = getExecutor(db);
    const challengeToken = crypto.randomBytes(24).toString('hex');
    const codeLength = normalizeCodeLength(config.email.loginOtpLength);
    const code = randomCode(codeLength);
    const challengeHash = hashValue(challengeToken);
    const codeHash = hashValue(code);

    await executor.query(
      `INSERT INTO login_email_otp_challenges
         (user_id, challenge_hash, code_hash, expires_at, requested_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, challengeHash, codeHash, expiresAt, requestedIp, userAgent]
    );

    return { challengeToken, code };
  },

  async findValidByChallengeToken(challengeToken, db) {
    const executor = getExecutor(db);
    const challengeHash = hashValue(challengeToken);
    const maxAttempts = Math.max(1, Number(config.email.loginOtpMaxAttempts || 5));
    const { rows } = await executor.query(
      `SELECT *
       FROM login_email_otp_challenges
       WHERE challenge_hash = $1
         AND consumed_at IS NULL
         AND expires_at > NOW()
         AND attempt_count < $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [challengeHash, maxAttempts]
    );
    return rows[0] || null;
  },

  async findPendingByChallengeToken(challengeToken, db) {
    const executor = getExecutor(db);
    const challengeHash = hashValue(challengeToken);
    const { rows } = await executor.query(
      `SELECT *
       FROM login_email_otp_challenges
       WHERE challenge_hash = $1
         AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [challengeHash]
    );
    return rows[0] || null;
  },

  verifyCode(challenge, code) {
    return challenge && challenge.code_hash === hashValue(code);
  },

  async incrementAttempt(id, db) {
    const executor = getExecutor(db);
    const { rows } = await executor.query(
      `UPDATE login_email_otp_challenges
       SET attempt_count = attempt_count + 1
       WHERE id = $1
       RETURNING attempt_count`,
      [id]
    );
    return rows[0]?.attempt_count ?? null;
  },

  async consume(id, db) {
    const executor = getExecutor(db);
    const { rowCount } = await executor.query(
      `UPDATE login_email_otp_challenges
       SET consumed_at = NOW()
       WHERE id = $1
         AND consumed_at IS NULL`,
      [id]
    );
    return rowCount > 0;
  },

  async revokeAllForUser(userId, db) {
    const executor = getExecutor(db);
    await executor.query(
      `DELETE FROM login_email_otp_challenges
       WHERE user_id = $1`,
      [userId]
    );
  },

  async cleanup(db) {
    const executor = getExecutor(db);
    const { rowCount } = await executor.query(
      `DELETE FROM login_email_otp_challenges
       WHERE consumed_at IS NOT NULL
          OR expires_at < NOW()`
    );
    return rowCount;
  },
};

module.exports = LoginEmailOtpChallenge;
