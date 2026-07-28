const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { getRequestIp } = require('../utils/request-security');
const { logSecurityEvent } = require('../utils/security-events');

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function getTokenLike(req) {
  const authHeader = String(req.headers?.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() || null;
  }

  const cookieToken = req.cookies?.[config.authCookie?.name];
  if (typeof cookieToken === 'string' && cookieToken.trim()) {
    return cookieToken.trim();
  }

  return null;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email && email.includes('@') ? email : null;
}

function buildLimiter(options) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: options.message || 'Too many requests, please try again later' },
    keyGenerator: options.keyGenerator,
    skipSuccessfulRequests: Boolean(options.skipSuccessfulRequests),
    skip: () => config.nodeEnv === 'development',
    handler: (req, res) => {
      let key = null;
      try {
        key = typeof options.keyGenerator === 'function' ? options.keyGenerator(req, res) : null;
      } catch (_) {
        key = null;
      }

      logSecurityEvent('rate_limit_exceeded', {
        limiter: options.name || 'unnamed',
        method: req.method,
        route: req.originalUrl || req.url,
        ip: getRequestIp(req),
        userId: req.user?.id || null,
        key,
        max: options.max,
        windowMs: options.windowMs,
      });

      return res.status(429).json({ error: options.message || 'Too many requests, please try again later' });
    },
  });
}

function ipKeyGenerator(req) {
  return getRequestIp(req) || 'unknown-ip';
}

function userScopedKeyGenerator(req) {
  const userId = req.user?.id;
  const ip = getRequestIp(req) || 'unknown-ip';
  if (userId) {
    return `user:${userId}:ip:${ip}`;
  }

  const token = getTokenLike(req);
  if (token) {
    return `session:${hashValue(token)}:ip:${ip}`;
  }

  return `ip:${ip}`;
}

function authAttemptKeyGenerator(req) {
  const ip = getRequestIp(req) || 'unknown-ip';
  const email = normalizeEmail(req.body?.email);
  return email ? `auth:${ip}:${email}` : `auth:${ip}`;
}

function authEmailKeyGenerator(req) {
  const ip = getRequestIp(req) || 'unknown-ip';
  const email = normalizeEmail(req.body?.email);
  if (email) {
    return `auth-email:${ip}:${email}`;
  }

  const tokenLike = String(req.body?.challengeToken || req.body?.token || '').trim();
  if (tokenLike) {
    return `auth-email:${ip}:${hashValue(tokenLike)}`;
  }

  return userScopedKeyGenerator(req);
}

function authOtpKeyGenerator(req) {
  const ip = getRequestIp(req) || 'unknown-ip';
  const challengeToken = String(req.body?.challengeToken || '').trim();
  if (challengeToken) {
    return `auth-otp:${ip}:${hashValue(challengeToken)}`;
  }
  return `auth-otp:${ip}`;
}

const defaultApiLimiter = buildLimiter({
  ...config.defaultApiRateLimit,
  name: 'default-api',
  keyGenerator: userScopedKeyGenerator,
});

const healthLimiter = buildLimiter({
  ...config.healthRateLimit,
  name: 'health',
  message: 'Too many health checks, please try again later',
  keyGenerator: ipKeyGenerator,
});

const dashboardLimiter = buildLimiter({
  ...config.dashboardRateLimit,
  name: 'dashboard',
  keyGenerator: userScopedKeyGenerator,
});

const marketTickerLimiter = buildLimiter({
  ...config.marketTickerRateLimit,
  name: 'market-ticker',
  keyGenerator: userScopedKeyGenerator,
});

const pumpfunMetaLimiter = buildLimiter({
  ...config.pumpfunMetaRateLimit,
  name: 'pumpfun-meta',
  keyGenerator: userScopedKeyGenerator,
});

const catalogWriteLimiter = buildLimiter({
  ...config.catalogWriteRateLimit,
  name: 'catalog-write',
  keyGenerator: userScopedKeyGenerator,
});

const catalogReadLimiter = buildLimiter({
  ...config.catalogReadRateLimit,
  name: 'catalog-read',
  keyGenerator: userScopedKeyGenerator,
});

/**
 * Strict rate limiter for auth endpoints (login, register).
 * Much tighter limits to prevent brute force.
 */
const authLimiter = buildLimiter({
  ...config.authRateLimit,
  name: 'auth',
  message: 'Too many authentication attempts, please try again later',
  keyGenerator: authAttemptKeyGenerator,
  skipSuccessfulRequests: false,
});

const authEmailLimiter = buildLimiter({
  ...config.authEmailRateLimit,
  name: 'auth-email',
  message: 'Too many auth email requests, please try again later',
  keyGenerator: authEmailKeyGenerator,
  skipSuccessfulRequests: false,
});

const authOtpLimiter = buildLimiter({
  ...config.authOtpRateLimit,
  name: 'auth-otp',
  message: 'Too many verification attempts, please try again later',
  keyGenerator: authOtpKeyGenerator,
  skipSuccessfulRequests: false,
});

module.exports = {
  authLimiter,
  authEmailLimiter,
  authOtpLimiter,
  defaultApiLimiter,
  healthLimiter,
  dashboardLimiter,
  marketTickerLimiter,
  pumpfunMetaLimiter,
  catalogWriteLimiter,
  catalogReadLimiter,
};
