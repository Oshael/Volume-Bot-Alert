const express = require('express');
const config = require('../../config');
const { authenticate, authenticateAllowExpiredAccess, requireTrustedOrigin } = require('../middleware/auth');
const userAccess = require('../models/user-access');
const User = require('../models/user');
const EmailVerificationToken = require('../models/email-verification-token');
const UserSocialIdentity = require('../models/user-social-identity');
const emailService = require('../services/email-service');
const { sendEmailVerificationEmail } = require('../services/auth-email');
const { serializeUser } = require('../services/auth-session');
const { buildIdentitySnapshot } = require('../services/social-auth');

const router = express.Router();
const EMAIL_MAX_LENGTH = 254;

function normalizeTrimmedText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, maxLength);
}

function normalizeEmailInput(value) {
  return String(value || '').trim().toLowerCase().slice(0, EMAIL_MAX_LENGTH);
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
    delivery,
    expiresMinutes,
  };
}

function parseProfileInput(body) {
  const username = normalizeTrimmedText(body?.username, 64);
  const email = normalizeEmailInput(body?.email);
  const password = String(body?.password || '');
  const confirmPassword = String(body?.confirmPassword || '');
  return {
    username,
    email,
    password,
    confirmPassword,
    wantsWalletCompletion: Boolean(email || password || confirmPassword),
  };
}

function validateWalletCompletionRequest(reqUser, input) {
  if (!User.isWalletOnlyEmail(reqUser.email)) {
    throw Object.assign(new Error('Email and password can only be added to wallet-only accounts'), { status: 409 });
  }
  if (!input.email || !input.password || !input.confirmPassword) {
    throw Object.assign(new Error('Email, password, and confirmation are required'), { status: 400 });
  }
  if (input.password !== input.confirmPassword) {
    throw Object.assign(new Error('Password confirmation does not match'), { status: 400 });
  }
}

async function sendCompletionVerification({ req, user }) {
  if (!config.email.enabled) {
    return null;
  }

  const verification = await issueEmailVerification({
    user,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  });
  return buildEmailDebug(verification.delivery);
}

async function completeWalletOnlyProfile(req, input) {
  validateWalletCompletionRequest(req.user, input);
  const user = await User.completeWalletOnlyAccount(req.user.id, {
    username: input.username,
    email: input.email,
    password: input.password,
  });

  const response = {
    message: 'Account details saved. Verify your email before using email login.',
    user,
    emailVerificationRequired: true,
    emailDebug: null,
  };

  try {
    response.emailDebug = await sendCompletionVerification({ req, user });
  } catch (emailErr) {
    console.error('Email verification send error after wallet account completion:', emailErr);
    response.message = 'Account details saved. Verification email could not be sent; request a new verification email before email login.';
  }

  return response;
}

async function updateAccountProfile(req, res) {
  try {
    const input = parseProfileInput(req.body);

    if (!input.username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = input.wantsWalletCompletion
      ? await completeWalletOnlyProfile(req, input)
      : {
          message: 'Profile updated.',
          user: await User.updateUsername(req.user.id, input.username),
          emailVerificationRequired: false,
          emailDebug: null,
        };

    return res.json({
      message: result.message,
      user: serializeUser(result.user),
      emailVerificationRequired: result.emailVerificationRequired,
      emailDebug: result.emailDebug,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Account profile update error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

router.get('/access', authenticateAllowExpiredAccess, async (req, res) => {
  try {
    res.json(req.access || await userAccess.buildResolvedAccessSnapshot(req.user));
  } catch (err) {
    console.error('Account access status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/identities', authenticate, async (req, res) => {
  try {
    const [identities, userWithPassword] = await Promise.all([
      UserSocialIdentity.listByUserId(req.user.id),
      User.findByEmail(req.user.email),
    ]);
    const hasPasswordLogin = User.isUsablePasswordHash(userWithPassword?.password_hash);
    res.json({
      providers: buildIdentitySnapshot(identities, { hasPasswordLogin }),
      hasPasswordLogin,
    });
  } catch (err) {
    console.error('Account identities status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/profile', authenticate, requireTrustedOrigin, updateAccountProfile);

module.exports = router;
