const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const Invite = require('../models/invite');
const Session = require('../models/session');
const LoginAttempt = require('../models/login-attempt');
const EmailVerificationToken = require('../models/email-verification-token');
const PasswordResetToken = require('../models/password-reset-token');
const socketHub = require('../services/socket-hub');
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const { sendEmailVerificationEmail, sendPasswordResetEmail, sendPasswordChangedEmail } = require('../services/auth-email');
const { authLimiter, authEmailLimiter } = require('../middleware/rate-limit');
const { getClient } = require('../models/db');

const router = express.Router();

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    isActive: Boolean(user.is_active),
    isEmailVerified: Boolean(user.is_email_verified),
    emailVerifiedAt: user.email_verified_at || null,
  };
}

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
    user: serializeUser(user),
  };

  if (config.nodeEnv === 'test') {
    payload.token = token;
  }

  return payload;
}

async function issueEmailVerification({ user, ipAddress, userAgent }) {
  const expiresMinutes = Math.max(5, parseInt(config.email.verificationExpiresMinutes || 60, 10));
  const expiresAt = new Date(Date.now() + (expiresMinutes * 60 * 1000));

  await EmailVerificationToken.revokeAllForUser(user.id);
  const { token } = await EmailVerificationToken.create({
    userId: user.id,
    expiresAt,
    requestedIp: ipAddress,
    userAgent,
  });

  const delivery = await sendEmailVerificationEmail({
    to: user.email,
    username: user.username,
    token,
    expiresMinutes,
  });

  return {
    expiresAt,
    expiresMinutes,
    delivery,
  };
}

async function issuePasswordReset({ user, ipAddress, userAgent }) {
  const expiresMinutes = Math.max(5, parseInt(config.email.passwordResetExpiresMinutes || 30, 10));
  const expiresAt = new Date(Date.now() + (expiresMinutes * 60 * 1000));

  await PasswordResetToken.revokeAllForUser(user.id);
  const { token } = await PasswordResetToken.create({
    userId: user.id,
    expiresAt,
    requestedIp: ipAddress,
    userAgent,
  });

  const delivery = await sendPasswordResetEmail({
    to: user.email,
    username: user.username,
    token,
    expiresMinutes,
  });

  return {
    expiresAt,
    expiresMinutes,
    delivery,
  };
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

    await Invite.incrementUse(invite.id, client);
    await client.query('COMMIT');

    let verificationEmailSent = false;
    let verificationEmailError = null;
    if (config.email.enabled) {
      try {
        await issueEmailVerification({
          user,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
        verificationEmailSent = true;
      } catch (emailErr) {
        verificationEmailError = 'Verification email could not be sent';
        console.error('Verification email send error after register:', emailErr);
      }
    }

    clearAuthCookie(res);
    res.status(201).json({
      ...buildAuthResponse('Account created successfully', user, null),
      emailVerificationRequired: !user.is_email_verified,
      verificationEmailSent,
      verificationEmailError,
    });
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

    if (!user.is_email_verified) {
      await LoginAttempt.record({ email, ipAddress: req.ip, success: false, userAgent: req.get('user-agent') });
      return res.status(403).json({ error: 'Email not verified. Check your inbox or resend verification before signing in.' });
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
  res.json({ user: serializeUser(req.user) });
});

router.post('/verify-email/request', authEmailLimiter, async (req, res) => {
  try {
    if (!config.email.enabled) {
      return res.status(503).json({ error: 'Email delivery is not configured' });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const genericResponse = {
      message: 'If an eligible account exists for that email, a verification link has been sent',
      alreadyVerified: false,
    };

    const user = await User.findByEmail(email);
    if (!user || !user.is_active) {
      return res.json(genericResponse);
    }
    if (user.is_email_verified) {
      return res.json({
        message: 'Email is already verified',
        alreadyVerified: true,
      });
    }

    await issueEmailVerification({
      user,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json(genericResponse);
  } catch (err) {
    console.error('Verify-email request error:', err);
    res.status(500).json({
      error: config.nodeEnv === 'development'
        ? (err.message || 'Internal server error')
        : 'Internal server error',
    });
  }
});

router.post('/verify-email/confirm', authEmailLimiter, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    const verification = await EmailVerificationToken.findValidByToken(token);
    if (!verification) {
      return res.status(400).json({ error: 'Verification token is invalid or expired' });
    }

    const consumed = await EmailVerificationToken.consume(verification.id);
    if (!consumed) {
      return res.status(400).json({ error: 'Verification token is invalid or already used' });
    }

    const user = await User.markEmailVerified(verification.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Email verified successfully',
      user: serializeUser(user),
    });
  } catch (err) {
    console.error('Verify-email confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/password-reset/request', authEmailLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!config.email.enabled) {
      return res.status(503).json({ error: 'Email delivery is not configured' });
    }

    const genericResponse = {
      message: 'If an eligible account exists for that email, a password reset link has been sent',
    };

    const user = await User.findByEmail(email);
    if (!user || !user.is_active || !user.is_email_verified) {
      return res.json(genericResponse);
    }

    try {
      await issuePasswordReset({
        user,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    } catch (emailErr) {
      console.error('Password reset email send error:', emailErr);
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error('Password-reset request error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/password-reset/confirm', authEmailLimiter, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Reset token and new password are required' });
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be 8–128 characters' });
    }

    const resetToken = await PasswordResetToken.findValidByToken(token);
    if (!resetToken) {
      return res.status(400).json({ error: 'Reset token is invalid or expired' });
    }

    const consumed = await PasswordResetToken.consume(resetToken.id);
    if (!consumed) {
      return res.status(400).json({ error: 'Reset token is invalid or already used' });
    }

    const user = await User.findById(resetToken.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const bcrypt = require('bcrypt');
    const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    const { query: dbQuery } = require('../models/db');
    await dbQuery('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

    if (config.email.enabled) {
      try {
        await sendPasswordChangedEmail({
          to: user.email,
          username: user.username,
        });
      } catch (emailErr) {
        console.error('Password changed email send error after reset:', emailErr);
      }
    }

    await PasswordResetToken.revokeAllForUser(user.id);
    await Session.revokeAllForUser(user.id);
    socketHub.revokeUserSockets(user.id, 'password_reset');

    clearAuthCookie(res);
    return res.json({ message: 'Password reset successful. Please login again.' });
  } catch (err) {
    console.error('Password-reset confirm error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
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

    if (config.email.enabled) {
      try {
        await sendPasswordChangedEmail({
          to: req.user.email,
          username: req.user.username,
        });
      } catch (emailErr) {
        console.error('Password changed email send error:', emailErr);
      }
    }

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
