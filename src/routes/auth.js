const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const Invite = require('../models/invite');
const Session = require('../models/session');
const LoginAttempt = require('../models/login-attempt');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rate-limit');

const router = express.Router();

/**
 * POST /api/auth/register
 * Body: { username, email, password, inviteCode }
 */
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, inviteCode } = req.body;

    // Validate all fields present
    if (!username || !email || !password || !inviteCode) {
      return res.status(400).json({ error: 'All fields are required: username, email, password, inviteCode' });
    }

    // Validate invite code first
    const validation = await Invite.validate(inviteCode);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.reason });
    }

    // Consume the invite atomically (prevents race condition)
    const invite = await Invite.consume(inviteCode);
    if (!invite) {
      return res.status(400).json({ error: 'Invite code is no longer valid' });
    }

    // Create user
    const user = await User.create({
      username,
      email,
      password,
      invitedBy: invite.created_by,
      inviteCode: invite.code,
    });

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    // Calculate token expiry for session
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    // Create session
    await Session.create({
      userId: user.id,
      token,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      expiresAt,
    });

    await User.updateLastLogin(user.id);

    res.status(201).json({
      message: 'Account created successfully',
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
      token,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check lockout before anything else
    const lockout = await LoginAttempt.checkLockout(email, req.ip);
    if (lockout.locked) {
      return res.status(429).json({
        error: lockout.reason,
        retryAfterSeconds: lockout.retryAfterSeconds,
      });
    }

    // Find user
    const user = await User.findByEmail(email);
    if (!user) {
      await LoginAttempt.record({ email, ipAddress: req.ip, success: false, userAgent: req.get('user-agent') });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const valid = await User.verifyPassword(password, user.password_hash);
    if (!valid) {
      await LoginAttempt.record({ email, ipAddress: req.ip, success: false, userAgent: req.get('user-agent') });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if user is active
    if (!user.is_active) {
      await LoginAttempt.record({ email, ipAddress: req.ip, success: false, userAgent: req.get('user-agent') });
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    // Record successful login
    await LoginAttempt.record({ email, ipAddress: req.ip, success: true, userAgent: req.get('user-agent') });

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    // Create session
    await Session.create({
      userId: user.id,
      token,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      expiresAt,
    });

    await User.updateLastLogin(user.id);

    res.json({
      message: 'Login successful',
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/logout
 * Requires: Bearer token
 */
router.post('/logout', authenticate, async (req, res) => {
  try {
    await Session.revoke(req.token);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/logout-all
 * Revoke all sessions (logout everywhere). Requires: Bearer token.
 */
router.post('/logout-all', authenticate, async (req, res) => {
  try {
    const count = await Session.revokeAllForUser(req.user.id);
    res.json({ message: `Logged out from ${count} session(s)` });
  } catch (err) {
    console.error('Logout-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/me
 * Returns current user info. Requires: Bearer token.
 */
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

/**
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 */
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be 8–128 characters' });
    }

    // Verify current password
    const user = await User.findByEmail(req.user.email);
    const valid = await User.verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash and update
    const bcrypt = require('bcrypt');
    const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    const { query: dbQuery } = require('../models/db');
    await dbQuery('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    // Revoke all sessions (force re-login)
    await Session.revokeAllForUser(req.user.id);

    res.json({ message: 'Password changed. Please login again.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
