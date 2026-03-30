const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const userAccess = require('../models/user-access');
const { serializeUser } = require('./auth-session');

function setPreAccessCookie(res, token, expiresAt) {
  res.cookie(config.preAccessCookie.name, token, {
    httpOnly: true,
    secure: config.preAccessCookie.secure,
    sameSite: config.preAccessCookie.sameSite,
    domain: config.preAccessCookie.domain,
    path: '/',
    expires: expiresAt,
  });
}

function clearPreAccessCookie(res) {
  res.clearCookie(config.preAccessCookie.name, {
    httpOnly: true,
    secure: config.preAccessCookie.secure,
    sameSite: config.preAccessCookie.sameSite,
    domain: config.preAccessCookie.domain,
    path: '/',
  });
}

function isBillingRecoveryAccess(access) {
  return access?.denialCode === 'access_inactive' || access?.denialCode === 'access_expired';
}

function isHardBlockedAccess(access) {
  return access?.denialCode === 'access_revoked';
}

function issuePreAccessFlow({ user, res }) {
  const expiresMinutes = Math.max(5, Number.parseInt(config.preAccessCookie.expiresMinutes || 30, 10) || 30);
  const expiresAt = new Date(Date.now() + (expiresMinutes * 60 * 1000));
  const token = jwt.sign(
    { userId: user.id, role: user.role, type: 'pre_access' },
    config.jwt.secret,
    { expiresIn: `${expiresMinutes}m` }
  );

  setPreAccessCookie(res, token, expiresAt);

  const payload = {
    message: 'Access payment required before entering the bot.',
    requiresPreAccess: true,
    redirectPath: '/access',
    user: serializeUser(user),
  };

  if (config.nodeEnv === 'test') {
    payload.preAccessToken = token;
  }

  return payload;
}

function readPreAccessToken(req) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = req.cookies?.[config.preAccessCookie.name] || null;
  return {
    token: bearerToken || cookieToken,
    authSource: bearerToken ? 'bearer' : cookieToken ? 'cookie' : null,
  };
}

function authenticatePreAccess(req, res, next) {
  const { token, authSource } = readPreAccessToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Pre-access authentication required' });
  }

  jwt.verify(token, config.jwt.secret, async (err, decoded) => {
    if (err || decoded?.type !== 'pre_access') {
      clearPreAccessCookie(res);
      return res.status(401).json({ error: 'Invalid pre-access session' });
    }

    try {
      const user = await User.findById(decoded.userId);
      if (!user) {
        clearPreAccessCookie(res);
        return res.status(401).json({ error: 'User not found' });
      }
      if (!user.is_active) {
        clearPreAccessCookie(res);
        return res.status(403).json({ error: 'Account is deactivated' });
      }
      if (!user.is_email_verified) {
        clearPreAccessCookie(res);
        return res.status(403).json({ error: 'Email not verified' });
      }

      const access = userAccess.buildAccessSnapshot(user);
      if (isHardBlockedAccess(access)) {
        clearPreAccessCookie(res);
        return res.status(403).json({ error: access.denialReason || 'Access revoked' });
      }

      req.user = user;
      req.access = access;
      req.preAccessToken = token;
      req.authSource = authSource;
      next();
    } catch (dbErr) {
      console.error('Pre-access auth DB error:', dbErr.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}

module.exports = {
  setPreAccessCookie,
  clearPreAccessCookie,
  issuePreAccessFlow,
  authenticatePreAccess,
  isBillingRecoveryAccess,
  isHardBlockedAccess,
};
