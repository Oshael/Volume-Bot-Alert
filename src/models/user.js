const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { query } = require('./db');
const config = require('../../config');

function getExecutor(db) {
  return db && typeof db.query === 'function' ? db : { query };
}

function validateUsername(username) {
  if (!username || username.length < 3 || username.length > 32) {
    throw Object.assign(new Error('Username must be 3-32 characters'), { status: 400 });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    throw Object.assign(new Error('Username can only contain letters, numbers, and underscores'), { status: 400 });
  }
}

function validateEmail(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('Invalid email format'), { status: 400 });
  }
}

function validatePassword(password) {
  if (!password || password.length < 8 || password.length > 128) {
    throw Object.assign(new Error('Password must be 8-128 characters'), { status: 400 });
  }
}

function isWalletOnlyEmail(email) {
  return /^wallet_[^@]+@wallet\.local$/i.test(String(email || '').trim());
}

function isUsablePasswordHash(passwordHash) {
  return /^\$2[aby]\$\d{2}\$/.test(String(passwordHash || ''));
}

function mapUniqueViolation(err) {
  if (err.code === '23505') {
    if (err.constraint?.includes('username')) {
      throw Object.assign(new Error('Username already taken'), { status: 409 });
    }
    if (err.constraint?.includes('email')) {
      throw Object.assign(new Error('Email already registered'), { status: 409 });
    }
  }
  throw err;
}

const User = {
  /**
   * Create a new user. Returns the created user (without password_hash).
   */
  async create({ username, email, password, invitedBy = null, inviteCode = null }, db) {
    // Validate input lengths
    validateUsername(username);
    validateEmail(email);
    validatePassword(password);

    const executor = getExecutor(db);
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    try {
      const { rows } = await executor.query(
        `INSERT INTO users (username, email, password_hash, invited_by, invite_code)
         VALUES ($1, LOWER($2), $3, $4, $5)
         RETURNING id, username, email, role, is_active, is_email_verified, email_verified_at, created_at`,
        [username, email, passwordHash, invitedBy, inviteCode]
      );
      return rows[0];
    } catch (err) {
      mapUniqueViolation(err);
    }
  },

  async createWalletOnly({ username, walletAddress }, db) {
    validateUsername(username);

    const normalizedWallet = String(walletAddress || '').trim().toLowerCase();
    if (!normalizedWallet) {
      throw Object.assign(new Error('Wallet address is required'), { status: 400 });
    }

    const executor = getExecutor(db);
    const syntheticEmail = `wallet_${normalizedWallet}@wallet.local`;
    const passwordHash = `wallet-only:${crypto.randomBytes(24).toString('hex')}`;

    try {
      const { rows } = await executor.query(
        `INSERT INTO users (
           username,
           email,
           password_hash,
           is_email_verified,
           email_verified_at,
           access_status,
           access_source
         )
         VALUES ($1, $2, $3, true, NOW(), 'inactive', 'manual')
         RETURNING id, username, email, role, is_active, is_email_verified, email_verified_at,
                   access_status, access_granted_at, access_expires_at, access_source, access_updated_at,
                   created_at, last_login`,
        [username, syntheticEmail, passwordHash]
      );
      return rows[0] || null;
    } catch (err) {
      if (err.code === '23505') {
        if (err.constraint?.includes('username')) {
          throw Object.assign(new Error('Username already taken'), { status: 409 });
        }
        if (err.constraint?.includes('email')) {
          throw Object.assign(new Error('Wallet account already exists'), { status: 409 });
        }
      }
      throw err;
    }
  },

  async createSocialOnly({ username, email }, db) {
    validateUsername(username);
    validateEmail(email);

    const executor = getExecutor(db);
    const passwordHash = `oauth-only:${crypto.randomBytes(24).toString('hex')}`;

    try {
      const { rows } = await executor.query(
        `INSERT INTO users (
           username,
           email,
           password_hash,
           is_email_verified,
           email_verified_at,
           access_status,
           access_source
         )
         VALUES ($1, LOWER($2), $3, true, NOW(), 'inactive', 'manual')
         RETURNING id, username, email, role, is_active, is_email_verified, email_verified_at,
                   access_status, access_granted_at, access_expires_at, access_source, access_updated_at,
                   created_at, last_login`,
        [username, email, passwordHash]
      );
      return rows[0] || null;
    } catch (err) {
      mapUniqueViolation(err);
    }
  },

  async updateUsername(id, username, db) {
    validateUsername(username);
    const executor = getExecutor(db);
    try {
      const { rows } = await executor.query(
        `UPDATE users
         SET username = $2
         WHERE id = $1
         RETURNING id, username, email, role, is_active, is_email_verified, email_verified_at,
                   access_status, access_granted_at, access_expires_at, access_source, access_updated_at,
                   created_at, last_login`,
        [id, username]
      );
      return rows[0] || null;
    } catch (err) {
      mapUniqueViolation(err);
    }
  },

  async completeWalletOnlyAccount(id, { username, email, password }, db) {
    validateUsername(username);
    validateEmail(email);
    validatePassword(password);
    const executor = getExecutor(db);
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    try {
      const { rows } = await executor.query(
        `UPDATE users
         SET username = $2,
             email = LOWER($3),
             password_hash = $4,
             is_email_verified = false,
             email_verified_at = NULL
         WHERE id = $1
           AND email ~* '^wallet_[^@]+@wallet\\.local$'
         RETURNING id, username, email, role, is_active, is_email_verified, email_verified_at,
                   access_status, access_granted_at, access_expires_at, access_source, access_updated_at,
                   created_at, last_login`,
        [id, username, email, passwordHash]
      );
      if (!rows[0]) {
        throw Object.assign(new Error('Account is not wallet-only'), { status: 409 });
      }
      return rows[0];
    } catch (err) {
      mapUniqueViolation(err);
    }
  },

  /**
   * Find user by email (for login). Includes password_hash.
   */
  async findByEmail(email) {
    const { rows } = await query(
      'SELECT * FROM users WHERE email = LOWER($1)',
      [email]
    );
    return rows[0] || null;
  },

  /**
   * Find user by ID (for auth middleware). Excludes password_hash.
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, username, email, role, is_active, is_email_verified, email_verified_at,
              access_status, access_granted_at, access_expires_at, access_source, access_updated_at,
              created_at, last_login
       FROM users
       WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async markEmailVerified(id, db) {
    const executor = getExecutor(db);
    const { rows } = await executor.query(
      `UPDATE users
       SET is_email_verified = true,
           email_verified_at = COALESCE(email_verified_at, NOW())
       WHERE id = $1
       RETURNING id, username, email, role, is_active, is_email_verified, email_verified_at,
                 access_status, access_granted_at, access_expires_at, access_source, access_updated_at,
                 created_at, last_login`,
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Verify password against hash.
   */
  async verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
  },

  /**
   * Update last_login timestamp.
   */
  async updateLastLogin(id, db) {
    const executor = getExecutor(db);
    await executor.query('UPDATE users SET last_login = NOW() WHERE id = $1', [id]);
  },

  /**
   * Deactivate a user (soft ban).
   */
  async setActive(id, active) {
    const { rows } = await query(
      'UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id, username, is_active',
      [id, active]
    );
    return rows[0] || null;
  },

  /**
   * List all users (admin). Excludes password_hash.
   */
  async listAll() {
    const { rows } = await query(
      'SELECT id, username, email, role, is_active, invited_by, invite_code, created_at, last_login FROM users ORDER BY created_at DESC'
    );
    return rows;
  },

  isWalletOnlyEmail,
  isUsablePasswordHash,
};

module.exports = User;
