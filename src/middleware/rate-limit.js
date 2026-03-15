const rateLimit = require('express-rate-limit');
const config = require('../../config');

/**
 * General API rate limiter.
 */
const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  keyGenerator: (req) => req.ip,
  skip: () => config.nodeEnv === 'development',
});

/**
 * Strict rate limiter for auth endpoints (login, register).
 * Much tighter limits to prevent brute force.
 */
const authLimiter = rateLimit({
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
  keyGenerator: (req) => req.ip,
  skipSuccessfulRequests: false,
  skip: () => config.nodeEnv === 'development',
});

module.exports = { generalLimiter, authLimiter };
