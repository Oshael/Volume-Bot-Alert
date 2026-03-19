const { v4: uuidv4 } = require('uuid');
const { query } = require('./db');
const config = require('../../config');

function getExecutor(db) {
  return db && typeof db.query === 'function' ? db : { query };
}

const Invite = {
  /**
   * Create a new invite code.
   */
  async create(createdBy, { maxUses, expiryHours } = {}) {
    const code = uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase();
    const uses = maxUses || config.invite.maxUses;
    const hours = expiryHours || config.invite.expiryHours;

    const { rows } = await query(
      `INSERT INTO invites (code, created_by, max_uses, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour' * $4)
       RETURNING id, code, created_by, max_uses, use_count, expires_at, created_at`,
      [code, createdBy, uses, hours]
    );
    return rows[0];
  },

  /**
   * Validate and consume an invite code.
   * Returns the invite if valid, null if invalid/expired/exhausted.
   * Atomically increments use_count to prevent race conditions.
   */
  async consume(code) {
    const { rows } = await query(
      `UPDATE invites
       SET use_count = use_count + 1
       WHERE code = $1
         AND is_revoked = false
         AND expires_at > NOW()
         AND use_count < max_uses
       RETURNING id, code, created_by, max_uses, use_count, expires_at`,
      [code]
    );
    return rows[0] || null;
  },

  /**
   * Check if an invite code is valid without consuming it.
   */
  async validate(code) {
    const { rows } = await query(
      `SELECT id, code, created_by, max_uses, use_count, expires_at, is_revoked
       FROM invites
       WHERE code = $1`,
      [code]
    );
    if (!rows[0]) return { valid: false, reason: 'Invite code not found' };
    const inv = rows[0];
    if (inv.is_revoked) return { valid: false, reason: 'Invite code has been revoked' };
    if (new Date(inv.expires_at) <= new Date()) return { valid: false, reason: 'Invite code has expired' };
    if (inv.use_count >= inv.max_uses) return { valid: false, reason: 'Invite code has reached max uses' };
    return { valid: true, invite: inv };
  },

  /**
   * Lock a valid invite row during registration so it can only be consumed on success.
   */
  async lockValid(code, db) {
    const executor = getExecutor(db);
    const { rows } = await executor.query(
      `SELECT id, code, created_by, max_uses, use_count, expires_at, is_revoked
       FROM invites
       WHERE code = $1
       FOR UPDATE`,
      [code]
    );
    if (!rows[0]) return { valid: false, reason: 'Invite code not found' };
    const inv = rows[0];
    if (inv.is_revoked) return { valid: false, reason: 'Invite code has been revoked' };
    if (new Date(inv.expires_at) <= new Date()) return { valid: false, reason: 'Invite code has expired' };
    if (inv.use_count >= inv.max_uses) return { valid: false, reason: 'Invite code has reached max uses' };
    return { valid: true, invite: inv };
  },

  /**
   * Increment invite use count after registration succeeds.
   */
  async incrementUse(id, db) {
    const executor = getExecutor(db);
    const { rows } = await executor.query(
      `UPDATE invites
       SET use_count = use_count + 1
       WHERE id = $1
       RETURNING id, code, created_by, max_uses, use_count, expires_at`,
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Revoke an invite code.
   */
  async revoke(id, userId) {
    const { rows } = await query(
      `UPDATE invites SET is_revoked = true
       WHERE id = $1 AND created_by = $2
       RETURNING id, code, is_revoked`,
      [id, userId]
    );
    return rows[0] || null;
  },

  /**
   * Revoke by code (admin).
   */
  async revokeByCode(code) {
    const { rows } = await query(
      `UPDATE invites SET is_revoked = true WHERE code = $1 RETURNING id, code, is_revoked`,
      [code]
    );
    return rows[0] || null;
  },

  /**
   * List invites created by a user.
   */
  async listByUser(userId) {
    const { rows } = await query(
      `SELECT id, code, max_uses, use_count, expires_at, is_revoked, created_at
       FROM invites WHERE created_by = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  },

  /**
   * List all invites (admin).
   */
  async listAll() {
    const { rows } = await query(
      `SELECT i.*, u.username as created_by_username
       FROM invites i JOIN users u ON i.created_by = u.id
       ORDER BY i.created_at DESC`
    );
    return rows;
  },
};

module.exports = Invite;
