const rateLimit = require('express-rate-limit');
const config = require('../../config');

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
  });
}

function ipKeyGenerator(req) {
  return req.ip;
}

function userScopedKeyGenerator(req) {
  const userId = req.user?.id;
  return userId ? `${userId}:${req.ip}` : req.ip;
}

const defaultApiLimiter = buildLimiter({
  ...config.defaultApiRateLimit,
  keyGenerator: userScopedKeyGenerator,
});

const dashboardLimiter = buildLimiter({
  ...config.dashboardRateLimit,
  keyGenerator: userScopedKeyGenerator,
});

const pumpfunMetaLimiter = buildLimiter({
  ...config.pumpfunMetaRateLimit,
  keyGenerator: userScopedKeyGenerator,
});

const catalogWriteLimiter = buildLimiter({
  ...config.catalogWriteRateLimit,
  keyGenerator: userScopedKeyGenerator,
});

const catalogReadLimiter = buildLimiter({
  ...config.catalogReadRateLimit,
  keyGenerator: userScopedKeyGenerator,
});

/**
 * Strict rate limiter for auth endpoints (login, register).
 * Much tighter limits to prevent brute force.
 */
const authLimiter = buildLimiter({
  ...config.authRateLimit,
  message: 'Too many authentication attempts, please try again later',
  keyGenerator: ipKeyGenerator,
  skipSuccessfulRequests: false,
});

const authEmailLimiter = buildLimiter({
  ...config.authEmailRateLimit,
  message: 'Too many auth email requests, please try again later',
  keyGenerator: userScopedKeyGenerator,
  skipSuccessfulRequests: false,
});

const authOtpLimiter = buildLimiter({
  ...config.authOtpRateLimit,
  message: 'Too many verification attempts, please try again later',
  keyGenerator: ipKeyGenerator,
  skipSuccessfulRequests: false,
});

module.exports = {
  authLimiter,
  authEmailLimiter,
  authOtpLimiter,
  defaultApiLimiter,
  dashboardLimiter,
  pumpfunMetaLimiter,
  catalogWriteLimiter,
  catalogReadLimiter,
};
