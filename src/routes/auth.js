const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const Invite = require('../models/invite');
const Session = require('../models/session');
const LoginAttempt = require('../models/login-attempt');
const socketHub = require('../services/socket-hub');
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rate-limit');
const { getClient } = require('../models/db');

const router = express.Router();

function setAuthCookie(res, token, expiresAt) {
  res.cookie(config.authCookie.name, token, {
    httpOnly: true,
    secure: config.authCookie.secure,
    sameSite: config.authCookie.sameSite,
    domain: config.authCookie.domain,
    path: '/',
    expires: expiresAt,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(config.authCookie.name, {
    httpOnly: true,
    secure: config.authCookie.secure,
    sameSite: config.authCookie.sameSite,
    domain: config.authCookie.domain,
    path: '/',
  });
}

function buildAuthResponse(message, user, token) {
  const payload = {
    message,
    user: { id: user.id, username: user.username, email: user.email, role: user.role },
  };

  if (config.nodeEnv === 'test') {
    payload.token = token;
  }

  return payload;
}

router.post('/register', authLimiter, async (req, res) => {
  let client;
  try {
    const { username, email, password, inviteCode } = req.body;

    if (!username || !email || !password || !inviteCode) {
      return res.status(400).json({ error: 'All fields are required: username, email, password, inviteCode' });
    }

    const validation = await Invite.validate(inviteCode);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.reason });
    }

    client = await getClient();
    await client.query('BEGIN');

    const lockedInvite = await Invite.lockValid(inviteCode, client);
    if (!lockedInvite.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: lockedInvite.reason });
    }

    const invite = lockedInvite.invite;

    const user = await User.create({
      username,
      email,
      password,
      invitedBy: invite.created_by,
      inviteCode: invite.code,
    }, client);

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    await Session.create({
      userId: user.id,
      token,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      expiresAt,
    }, client);

    await User.updateLastLogin(user.id, client);
    await Invite.incrementUse(invite.id, client);
    await client.query('COMMIT');

    setAuthCookie(res, token, expiresAt);
    res.status(201).json(buildAuthResponse('Account created successfully', user, token));
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client?.release();
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const lockout = await LoginAttempt.checkLockout(email, req.ip);
    if (lockout.locked) {
      return res.status(429).json({
        error: lockout.reason,
        retryAfterSeconds: lockout.retryAfterSeconds,
      });
    }

    const user = await User.findByEmail(email);
    if (!user) {
      await LoginAttempt.record({ email, ipAddress: req.ip, success: false, userAgent: req.get('user-agent') });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await User.verifyPassword(password, user.password_hash);
    if (!valid) {
      await LoginAttempt.record({ email, ipAddress: req.ip, success: false, userAgent: req.get('user-agent') });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      await LoginAttempt.record({ email, ipAddress: req.ip, success: false, userAgent: req.get('user-agent') });
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    await LoginAttempt.record({ email, ipAddress: req.ip, success: true, userAgent: req.get('user-agent') });

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    await Session.create({
      userId: user.id,
      token,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      expiresAt,
    });

    await User.updateLastLogin(user.id);

    setAuthCookie(res, token, expiresAt);
    res.json(buildAuthResponse('Login successful', user, token));
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    await Session.revoke(req.token);
    socketHub.revokeUserSockets(req.user.id, 'logout');
    clearAuthCookie(res);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout-all', authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    const count = await Session.revokeAllForUser(req.user.id);
    socketHub.revokeUserSockets(req.user.id, 'logout_all');
    clearAuthCookie(res);
    res.json({ message: `Logged out from ${count} session(s)` });
  } catch (err) {
    console.error('Logout-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be 8–128 characters' });
    }

    const user = await User.findByEmail(req.user.email);
    const valid = await User.verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const bcrypt = require('bcrypt');
    const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    const { query: dbQuery } = require('../models/db');
    await dbQuery('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    await Session.revokeAllForUser(req.user.id);
    socketHub.revokeUserSockets(req.user.id, 'password_changed');

    clearAuthCookie(res);
    res.json({ message: 'Password changed. Please login again.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
