const express = require('express');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const User = require('../models/user');
const Invite = require('../models/invite');
const Session = require('../models/session');
const LoginAttempt = require('../models/login-attempt');
const { query } = require('../models/db');
const socketHub = require('../services/socket-hub');

const router = express.Router();

function parseInviteCreateOptions(body = {}) {
  const opts = {};
  const hasMaxUses = body.maxUses !== undefined && body.maxUses !== null && String(body.maxUses).trim() !== '';
  const hasExpiryHours = body.expiryHours !== undefined && body.expiryHours !== null && String(body.expiryHours).trim() !== '';

  if (hasMaxUses) {
    const parsed = Number.parseInt(body.maxUses, 10);
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: 'maxUses must be an integer' };
    }
    opts.maxUses = parsed;
  }

  if (hasExpiryHours) {
    const parsed = Number.parseInt(body.expiryHours, 10);
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: 'expiryHours must be an integer' };
    }
    opts.expiryHours = parsed;
  }

  return { ok: true, opts };
}

function parsePositiveId(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLogsLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 50;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return Math.min(parsed, 200);
}

function parseOptionalBooleanQuery(value) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return { ok: true, value: true };
  }
  if (normalized === 'false') {
    return { ok: true, value: false };
  }

  return { ok: false, error: 'success must be true or false' };
}

// All admin routes require authentication + admin role
router.use(authenticate);
router.use(requireAdmin);
router.use(requireTrustedOrigin);

// ============================================================
// USERS
// ============================================================

/**
 * GET /api/admin/users
 * List all users with invite tree info.
 */
router.get('/users', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT u.id, u.username, u.email, u.role, u.is_active,
             u.invited_by, inv.username as invited_by_username,
             u.invite_code, u.created_at, u.last_login
      FROM users u
      LEFT JOIN users inv ON u.invited_by = inv.id
      ORDER BY u.created_at DESC
    `);
    res.json({ users: rows, total: rows.length });
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/users/online
 * List currently online users (active sessions).
 */
router.get('/users/online', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT DISTINCT ON (u.id)
             u.id, u.username, u.role, s.ip_address, s.user_agent,
             s.created_at as session_started, s.expires_at
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.expires_at > NOW() AND u.is_active = true
      ORDER BY u.id, s.created_at DESC
    `);
    res.json({ online: rows, count: rows.length });
  } catch (err) {
    console.error('Admin online users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/admin/users/:id
 * Update user: activate/deactivate, change role.
 * Body: { is_active?, role? }
 * Cannot modify own account or other admins (unless you're the only admin).
 */
router.patch('/users/:id', async (req, res) => {
  try {
    const targetId = parsePositiveId(req.params.id);
    if (!targetId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Prevent self-modification
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot modify your own account via admin panel' });
    }

    // Get target user
    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent modifying other admins
    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Cannot modify another admin' });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    // Handle is_active
    if (typeof req.body.is_active === 'boolean') {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(req.body.is_active);
    }

    // Handle role change
    if (req.body.role && ['user', 'admin'].includes(req.body.role)) {
      updates.push(`role = $${paramIndex++}`);
      values.push(req.body.role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update. Use is_active (bool) or role (user/admin).' });
    }

    values.push(targetId);
    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, username, email, role, is_active`,
      values
    );

    // If user was deactivated, revoke all their sessions
    if (req.body.is_active === false) {
      const revokedCount = await Session.revokeAllForUser(targetId);
      socketHub.revokeUserSockets(targetId, 'admin_deactivated');
      return res.json({
        message: `User ${rows[0].username} deactivated, ${revokedCount} session(s) revoked`,
        user: rows[0],
      });
    }

    res.json({ message: `User ${rows[0].username} updated`, user: rows[0] });
  } catch (err) {
    console.error('Admin update user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/users/:id/sessions
 * Force-logout a user by revoking all their sessions.
 */
router.delete('/users/:id/sessions', async (req, res) => {
  try {
    const targetId = parsePositiveId(req.params.id);
    if (!targetId) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const target = await User.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const count = await Session.revokeAllForUser(targetId);
    socketHub.revokeUserSockets(targetId, 'admin_revoked');
    res.json({ message: `Revoked ${count} session(s) for ${target.username}` });
  } catch (err) {
    console.error('Admin revoke sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// INVITES
// ============================================================

/**
 * GET /api/admin/invites
 * List all invites with creator info.
 */
router.get('/invites', async (req, res) => {
  try {
    const invites = await Invite.listAll();
    res.json({ invites, total: invites.length });
  } catch (err) {
    console.error('Admin list invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/invites
 * Create invite with custom params.
 * Body: { maxUses?, expiryHours? }
 */
router.post('/invites', async (req, res) => {
  try {
    const parsed = parseInviteCreateOptions(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    const invite = await Invite.create(req.user.id, parsed.opts);
    res.status(201).json({ invite });
  } catch (err) {
    console.error('Admin create invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/invites/:id
 * Revoke any invite by ID.
 */
router.delete('/invites/:id', async (req, res) => {
  try {
    const inviteId = parsePositiveId(req.params.id);
    if (!inviteId) {
      return res.status(400).json({ error: 'Invalid invite ID' });
    }

    const { rows } = await query(
      'UPDATE invites SET is_revoked = true WHERE id = $1 RETURNING id, code, is_revoked',
      [inviteId]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    res.json({ message: 'Invite revoked', invite: rows[0] });
  } catch (err) {
    console.error('Admin revoke invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// LOGS
// ============================================================

/**
 * GET /api/admin/logs
 * Recent login attempts. Query: ?limit=50&email=&success=
 */
router.get('/logs', async (req, res) => {
  try {
    const limit = parseLogsLimit(req.query.limit);
    if (limit == null) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const parsedSuccess = parseOptionalBooleanQuery(req.query.success);
    if (!parsedSuccess.ok) {
      return res.status(400).json({ error: parsedSuccess.error });
    }

    let sql = `SELECT id, email, ip_address, success, user_agent, created_at
               FROM login_attempts`;
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (req.query.email) {
      conditions.push(`email = LOWER($${paramIndex++})`);
      values.push(String(req.query.email).trim().toLowerCase().slice(0, 254));
    }
    if (parsedSuccess.value !== undefined) {
      conditions.push(`success = $${paramIndex++}`);
      values.push(parsedSuccess.value);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    values.push(limit);

    const { rows } = await query(sql, values);
    res.json({ logs: rows, total: rows.length });
  } catch (err) {
    console.error('Admin logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// STATS
// ============================================================

/**
 * GET /api/admin/stats
 * Dashboard summary stats.
 */
router.get('/stats', async (req, res) => {
  try {
    const [users, sessions, invites, attempts] = await Promise.all([
      query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active FROM users'),
      query('SELECT COUNT(*) as total FROM sessions WHERE expires_at > NOW()'),
      query(`SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE NOT is_revoked AND expires_at > NOW() AND use_count < max_uses) as available
             FROM invites`),
      query(`SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE success = false AND created_at > NOW() - INTERVAL '1 hour') as failed_1h
             FROM login_attempts
             WHERE created_at > NOW() - INTERVAL '24 hours'`),
    ]);

    res.json({
      users: {
        total: parseInt(users.rows[0].total),
        active: parseInt(users.rows[0].active),
      },
      sessions: {
        active: parseInt(sessions.rows[0].total),
      },
      invites: {
        total: parseInt(invites.rows[0].total),
        available: parseInt(invites.rows[0].available),
      },
      loginAttempts24h: {
        total: parseInt(attempts.rows[0].total),
        failedLastHour: parseInt(attempts.rows[0].failed_1h),
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
