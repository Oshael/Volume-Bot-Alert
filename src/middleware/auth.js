const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const Session = require('../models/session');

/**
 * Middleware: require valid JWT + active session + active user.
 * Sets req.user on success.
 */
function authenticate(req, res, next) {
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
      // Check session is still valid (not revoked)
      const sessionValid = await Session.isValid(token);
      if (!sessionValid) {
        return res.status(401).json({ error: 'Session revoked, please login again' });
      }

      // Check user still exists and is active
      const user = await User.findById(decoded.userId);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      if (!user.is_active) {
        return res.status(403).json({ error: 'Account is deactivated' });
      }

      req.user = user;
      req.token = token;
      next();
    } catch (dbErr) {
      console.error('Auth middleware DB error:', dbErr.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
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

module.exports = { authenticate, requireAdmin };
