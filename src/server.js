const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('../config');
const { generalLimiter } = require('./middleware/rate-limit');
const Session = require('./models/session');
const LoginAttempt = require('./models/login-attempt');

// Routes
const authRoutes = require('./routes/auth');
const inviteRoutes = require('./routes/invites');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const bootstrapRoutes = require('./routes/bootstrap');

// Services
const socketHub = require('./services/socket-hub');

const app = express();
const server = http.createServer(app);

// ---- Security middlewares ----
app.use(helmet());
const allowedCorsOrigins = new Set(config.corsOrigins);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.has(origin)) return callback(null, true);

    if (config.nodeEnv === 'development') {
      if (origin === 'null') return callback(null, true);

      try {
        const parsed = new URL(origin);
        const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        if (isLocalHost) return callback(null, true);
      } catch (_) {
        // Ignore malformed origins and deny below.
      }
    }

    return callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(generalLimiter);

// Trust proxy (for rate limiting behind reverse proxy / Nginx)
app.set('trust proxy', 1);

// Enforce HTTPS behind reverse proxy in production when enabled.
if (config.nodeEnv === 'production' && config.forceHttps) {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    const host = req.headers.host;
    if (!host) return res.status(400).json({ error: 'Host header is required' });
    return res.redirect(308, `https://${host}${req.originalUrl}`);
  });
}

// ---- Request logging (dev) ----
if (config.nodeEnv === 'development') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
  });
}

// ---- Routes ----
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', require('./routes/config'));
app.use('/api/bootstrap', bootstrapRoutes);

// ---- WebSocket Hub Status (admin only) ----
const { authenticate, requireAdmin } = require('./middleware/auth');
app.get('/api/admin/ws-status', authenticate, requireAdmin, (req, res) => {
  res.json(socketHub.getStatus());
});

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---- Global error handler ----
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---- Periodic cleanup ----
setInterval(async () => {
  try {
    const sessions = await Session.cleanup();
    const attempts = await LoginAttempt.cleanup();
    if (sessions > 0 || attempts > 0) {
      console.log(`???? Cleanup: ${sessions} expired sessions, ${attempts} old login attempts`);
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}, 3600000); // every hour

// ---- Initialize Socket.io ----
socketHub.init(server);

// ---- Start ----
server.listen(config.port, () => {
  console.log('');
  console.log(`???? Volume Alert Server running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   CORS origins: ${config.corsOrigins.join(', ')}`);
  console.log('');
  console.log('   Endpoints:');
  console.log('   GET  /api/health           ??? Server status');
  console.log('   POST /api/auth/register    ??? Register (requires invite)');
  console.log('   POST /api/auth/login       ??? Login');
  console.log('   POST /api/auth/logout      ??? Logout');
  console.log('   POST /api/auth/logout-all  ??? Logout everywhere');
  console.log('   GET  /api/auth/me          ??? Current user');
  console.log('   POST /api/auth/change-password ??? Change password');
  console.log('   POST /api/invites          ??? Create invite');
  console.log('   GET  /api/invites          ??? List my invites');
  console.log('   GET  /api/invites/validate/:code ??? Validate invite');
  console.log('   DELETE /api/invites/:id     ??? Revoke invite');
  console.log('   --- Admin ---');
  console.log('   GET  /api/admin/stats       ??? Dashboard summary');
  console.log('   GET  /api/admin/users       ??? List all users');
  console.log('   GET  /api/admin/users/online ??? Online users');
  console.log('   PATCH /api/admin/users/:id  ??? Update user');
  console.log('   DELETE /api/admin/users/:id/sessions ??? Force logout');
  console.log('   GET  /api/admin/invites     ??? List all invites');
  console.log('   POST /api/admin/invites     ??? Create invite');
  console.log('   DELETE /api/admin/invites/:id ??? Revoke invite');
  console.log('   GET  /api/admin/logs        ??? Login attempts');
  console.log('   GET  /api/admin/ws-status   ??? WebSocket hub status');
  console.log('   --- WebSocket ---');
  console.log('   Socket.io on /            ??? Real-time data (JWT auth)');
  console.log('');
});

module.exports = { app, server }; // export for testing



