const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const Session = require('../models/session');
const User = require('../models/user');

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

module.exports = {
  serializeUser,
  setAuthCookie,
  clearAuthCookie,
  buildAuthResponse,
  createAuthenticatedSession,
};
