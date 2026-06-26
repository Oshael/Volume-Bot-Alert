const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const Session = require('../models/session');
const userAccess = require('../models/user-access');

/**
 * Middleware: require valid JWT + active session + active user.
 * Sets req.user on success.
 */
function createAuthenticateMiddleware({ allowExpiredAccess = false } = {}) {
  return function authenticateRequest(req, res, next) {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = req.cookies?.[config.authCookie.name] || null;
    const token = bearerToken || cookieToken;

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    jwt.verify(token, config.jwt.secret, async (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({ error: 'Token expired, please login again' });
        }
        return res.status(401).json({ error: 'Invalid token' });
      }

      try {
        const sessionValid = await Session.isValid(token);
        if (!sessionValid) {
          return res.status(401).json({ error: 'Session revoked, please login again' });
        }

        const user = await User.findById(decoded.userId);
        if (!user) {
          return res.status(401).json({ error: 'User not found' });
        }
        if (!user.is_active) {
          return res.status(403).json({ error: 'Account is deactivated' });
        }

        const access = await userAccess.buildResolvedAccessSnapshot(user);
        if (!allowExpiredAccess && !access.hasProductAccess) {
          return res.status(403).json({ error: access.denialReason || 'Access inactive' });
        }

        req.user = user;
        req.access = access;
        req.token = token;
        req.sessionId = Session.getSessionIdentity(token, decoded);
        req.authSource = bearerToken ? 'bearer' : 'cookie';
        next();
      } catch (dbErr) {
        console.error('Auth middleware DB error:', dbErr.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
    });
  };
}

const authenticate = createAuthenticateMiddleware();
const authenticateAllowExpiredAccess = createAuthenticateMiddleware({ allowExpiredAccess: true });

function requireTrustedOrigin(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  if (config.nodeEnv === 'test') {
    return next();
  }

  if (req.authSource && req.authSource !== 'cookie') {
    return next();
  }

  const origin = req.get('origin');
  const referer = req.get('referer');
  const candidate = origin || referer;

  if (!candidate) {
    return res.status(403).json({ error: 'Trusted origin required' });
  }

  try {
    const parsed = new URL(candidate);
    const normalizedOrigin = parsed.origin.replace(/\/+$/, '');
    const allowed = new Set(config.corsOrigins.map((value) => value.replace(/\/+$/, '')));

    if (allowed.has(normalizedOrigin)) {
      return next();
    }

    const requestOrigin = `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
    if (normalizedOrigin === requestOrigin) {
      return next();
    }
  } catch (_) {
    return res.status(403).json({ error: 'Trusted origin required' });
  }

  return res.status(403).json({ error: 'Trusted origin required' });
}

/**
 * Middleware: require admin role. Must be used AFTER authenticate.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authenticate, authenticateAllowExpiredAccess, requireAdmin, requireTrustedOrigin };
