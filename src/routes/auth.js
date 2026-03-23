const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const Invite = require('../models/invite');
const Session = require('../models/session');
const LoginAttempt = require('../models/login-attempt');
const EmailVerificationToken = require('../models/email-verification-token');
const PasswordResetToken = require('../models/password-reset-token');
const LoginEmailOtpChallenge = require('../models/login-email-otp-challenge');
const socketHub = require('../services/socket-hub');
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const { sendEmailVerificationEmail, sendPasswordResetEmail, sendPasswordChangedEmail, sendLoginOtpEmail } = require('../services/auth-email');
const { authLimiter, authEmailLimiter, authOtpLimiter } = require('../middleware/rate-limit');
const { getClient } = require('../models/db');
const emailService = require('../services/email-service');

const router = express.Router();
const EMAIL_MAX_LENGTH = 254;
const INVITE_CODE_MAX_LENGTH = 64;
const LOGIN_OTP_CHALLENGE_TOKEN_LENGTH = 48;
const EMAIL_ACTION_TOKEN_LENGTH = 64;

function normalizeTrimmedText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    return text;
  }
  return text.slice(0, maxLength);
}

function normalizeEmailInput(value) {
  return normalizeTrimmedText(value, EMAIL_MAX_LENGTH).toLowerCase();
}

function normalizeInviteCodeInput(value) {
  return normalizeTrimmedText(value, INVITE_CODE_MAX_LENGTH).toUpperCase();
}

function hasExactHexLength(value, length) {
  return typeof value === 'string'
    && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value);
}

function getLoginOtpLength() {
  const parsed = Number.parseInt(config.email.loginOtpLength, 10);
  if (!Number.isInteger(parsed)) {
    return 6;
  }
  return Math.max(4, parsed);
}

function isValidLoginOtpCode(code) {
  return typeof code === 'string'
    && new RegExp(`^\\d{${getLoginOtpLength()}}$`).test(code);
}

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

function maskEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const [localPart = '', domain = ''] = normalized.split('@');
  if (!localPart || !domain) {
    return normalized;
  }
  const visibleLocal = localPart.length <= 2
    ? `${localPart[0] || ''}*`
    : `${localPart.slice(0, 2)}${'*'.repeat(Math.max(2, localPart.length - 2))}`;
  return `${visibleLocal}@${domain}`;
}

function buildEmailDebug(delivery) {
  if (!emailService.shouldExposeEmailDebug()) {
    return null;
  }

  const debug = delivery?.debug;
  if (!debug) {
    return null;
  }

  return {
    mode: delivery.provider === 'local-dev' ? 'captured' : 'mirrored',
    provider: delivery.provider || null,
    flow: debug.flow || null,
    actionUrl: debug.actionUrl || null,
    otpCode: debug.otpCode || null,
    expiresMinutes: debug.expiresMinutes ?? null,
  };
}

async function createAuthenticatedSession({ user, ipAddress, userAgent, res }) {
  const sessionId = crypto.randomUUID();
  const token = jwt.sign(
    { userId: user.id, role: user.role, jti: sessionId },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  const decoded = jwt.decode(token);
  const expiresAt = new Date(decoded.exp * 1000);

  await Session.create({
    userId: user.id,
    token,
    ipAddress,
    userAgent,
    expiresAt,
  });

  await User.updateLastLogin(user.id);
  setAuthCookie(res, token, expiresAt);
  return buildAuthResponse('Login successful', user, token);
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

async function issueLoginOtp({ user, ipAddress, userAgent }) {
  const expiresMinutes = Math.max(3, parseInt(config.email.loginOtpExpiresMinutes || 10, 10));
  const expiresAt = new Date(Date.now() + (expiresMinutes * 60 * 1000));

  await LoginEmailOtpChallenge.revokeAllForUser(user.id);
  const { challengeToken, code } = await LoginEmailOtpChallenge.create({
    userId: user.id,
    expiresAt,
    requestedIp: ipAddress,
    userAgent,
  });

  const delivery = await sendLoginOtpEmail({
    to: user.email,
    username: user.username,
    code,
    expiresMinutes,
  });

  return {
    challengeToken,
    expiresAt,
    expiresMinutes,
    delivery,
  };
}

router.post('/register', authLimiter, async (req, res) => {
  let client;
  try {
    const username = normalizeTrimmedText(req.body?.username, 64);
    const email = normalizeEmailInput(req.body?.email);
    const password = String(req.body?.password || '');
    const inviteCode = normalizeInviteCodeInput(req.body?.inviteCode);

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
    let emailDebug = null;
    if (config.email.enabled) {
      try {
        const verification = await issueEmailVerification({
          user,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
        emailDebug = buildEmailDebug(verification.delivery);
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
      emailDebug,
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
    const email = normalizeEmailInput(req.body?.email);
    const password = String(req.body?.password || '');

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

    if (!config.email.enabled) {
      return res.status(503).json({ error: 'Email delivery is not configured' });
    }

    await LoginAttempt.record({ email, ipAddress: req.ip, success: true, userAgent: req.get('user-agent') });
    clearAuthCookie(res);
    const otp = await issueLoginOtp({
      user,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      message: 'Verification code sent. Check your email to finish signing in.',
      otpRequired: true,
      challengeToken: otp.challengeToken,
      otpEmailHint: maskEmail(user.email),
      emailDebug: buildEmailDebug(otp.delivery),
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login-otp/resend', authOtpLimiter, async (req, res) => {
  try {
    if (!config.email.enabled) {
      return res.status(503).json({ error: 'Email delivery is not configured' });
    }

    const challengeToken = normalizeTrimmedText(req.body?.challengeToken, LOGIN_OTP_CHALLENGE_TOKEN_LENGTH);
    if (!challengeToken) {
      return res.status(400).json({ error: 'Verification challenge is required' });
    }
    if (!hasExactHexLength(challengeToken, LOGIN_OTP_CHALLENGE_TOKEN_LENGTH)) {
      return res.status(400).json({ error: 'Verification challenge is invalid or expired. Please sign in again.' });
    }

    const challenge = await LoginEmailOtpChallenge.findPendingByChallengeToken(challengeToken);
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Verification challenge is invalid or expired. Please sign in again.' });
    }

    const user = await User.findById(challenge.user_id);
    if (!user || !user.is_active || !user.is_email_verified) {
      return res.status(400).json({ error: 'Verification challenge is invalid or expired. Please sign in again.' });
    }

    const nextChallenge = await issueLoginOtp({
      user,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      message: 'A new verification code has been sent.',
      challengeToken: nextChallenge.challengeToken,
      otpEmailHint: maskEmail(user.email),
      emailDebug: buildEmailDebug(nextChallenge.delivery),
    });
  } catch (err) {
    console.error('Login OTP resend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login-otp/verify', authOtpLimiter, async (req, res) => {
  try {
    const challengeToken = normalizeTrimmedText(req.body?.challengeToken, LOGIN_OTP_CHALLENGE_TOKEN_LENGTH);
    const code = normalizeTrimmedText(req.body?.code, 32);

    if (!challengeToken || !code) {
      return res.status(400).json({ error: 'Verification challenge and code are required' });
    }
    if (!hasExactHexLength(challengeToken, LOGIN_OTP_CHALLENGE_TOKEN_LENGTH)) {
      return res.status(400).json({ error: 'Verification code is invalid or expired. Please sign in again.' });
    }
    if (!isValidLoginOtpCode(code)) {
      return res.status(401).json({ error: 'Verification code is incorrect. Please try again.' });
    }

    const challenge = await LoginEmailOtpChallenge.findValidByChallengeToken(challengeToken);
    if (!challenge) {
      return res.status(400).json({ error: 'Verification code is invalid or expired. Please sign in again.' });
    }

    const user = await User.findById(challenge.user_id);
    if (!user || !user.is_active || !user.is_email_verified) {
      return res.status(400).json({ error: 'Verification code is invalid or expired. Please sign in again.' });
    }

    if (!LoginEmailOtpChallenge.verifyCode(challenge, code)) {
      const attempts = await LoginEmailOtpChallenge.incrementAttempt(challenge.id);
      const maxAttempts = Math.max(1, Number(config.email.loginOtpMaxAttempts || 5));
      if (attempts >= maxAttempts) {
        await LoginEmailOtpChallenge.revokeAllForUser(user.id);
        return res.status(400).json({ error: 'Too many invalid verification attempts. Please sign in again.' });
      }
      return res.status(401).json({ error: 'Verification code is incorrect. Please try again.' });
    }

    const consumed = await LoginEmailOtpChallenge.consume(challenge.id);
    if (!consumed) {
      return res.status(400).json({ error: 'Verification code is invalid or expired. Please sign in again.' });
    }

    await LoginEmailOtpChallenge.revokeAllForUser(user.id);
    const payload = await createAuthenticatedSession({
      user,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      res,
    });

    res.json(payload);
  } catch (err) {
    console.error('Login OTP verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    await Session.revoke(req.token);
    socketHub.revokeSessionSockets(req.sessionId, 'logout');
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

    const email = normalizeEmailInput(req.body?.email);
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

    const verification = await issueEmailVerification({
      user,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      ...genericResponse,
      emailDebug: buildEmailDebug(verification.delivery),
    });
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
    const token = normalizeTrimmedText(req.body?.token, EMAIL_ACTION_TOKEN_LENGTH);
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }
    if (!hasExactHexLength(token, EMAIL_ACTION_TOKEN_LENGTH)) {
      return res.status(400).json({ error: 'Verification token is invalid or expired' });
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
    const email = normalizeEmailInput(req.body?.email);
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
      const reset = await issuePasswordReset({
        user,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      return res.json({
        ...genericResponse,
        emailDebug: buildEmailDebug(reset.delivery),
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
    const token = normalizeTrimmedText(req.body?.token, EMAIL_ACTION_TOKEN_LENGTH);
    const newPassword = String(req.body?.newPassword || '');

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Reset token and new password are required' });
    }
    if (!hasExactHexLength(token, EMAIL_ACTION_TOKEN_LENGTH)) {
      return res.status(400).json({ error: 'Reset token is invalid or expired' });
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
