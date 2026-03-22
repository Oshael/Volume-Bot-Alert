const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('../config');
const { defaultApiLimiter } = require('./middleware/rate-limit');
const Session = require('./models/session');
const LoginAttempt = require('./models/login-attempt');

// Routes
const authRoutes = require('./routes/auth');
const inviteRoutes = require('./routes/invites');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const bootstrapRoutes = require('./routes/bootstrap');
const catalogRoutes = require('./routes/catalog');
const dashboardRoutes = require('./routes/dashboard');

// Services
const socketHub = require('./services/socket-hub');
const catalogWorker = require('./services/catalog-worker');
const catalogCleanupWorker = require('./services/catalog-cleanup-worker');
const meteoraSnapshotWorker = require('./services/meteora-snapshot-worker');
const dexDiscoveryWorker = require('./services/dex-discovery-worker');

const app = express();
let server = null;
let cleanupInterval = null;
let bootstrapped = false;

// ---- Security middlewares ----
const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  frameSrc: ["'none'"],
  formAction: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://api.fontshare.com'],
  fontSrc: ["'self'", 'data:', 'https:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: [
    "'self'",
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'ws://localhost:3000',
    'ws://127.0.0.1:3000',
    'ws://localhost:5173',
    'ws://127.0.0.1:5173',
    'https://volume-bot-alert-production.up.railway.app',
    'wss://volume-bot-alert-production.up.railway.app',
    'https://volume-alert-server-production.up.railway.app',
    'wss://volume-alert-server-production.up.railway.app',
  ],
  workerSrc: ["'self'", 'blob:'],
  manifestSrc: ["'self'"],
};

if (config.nodeEnv === 'production') {
  cspDirectives.upgradeInsecureRequests = [];
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: cspDirectives,
  },
}));
const allowedCorsOrigins = new Set(config.corsOrigins);
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedCorsOrigins.has(origin)) return true;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();

    if (config.nodeEnv === 'development') {
      const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';
      if (origin === 'null' || isLocalHost) return true;
    }

    // Accept Vercel aliases/preview deployments for the frontend project.
    if (hostname === 'volume-bot-alert-frontend.vercel.app') return true;
    if (hostname.endsWith('.vercel.app') && hostname.startsWith('volume-bot-alert-frontend-')) return true;
  } catch (_) {
    // Ignore malformed origins and deny below.
  }

  return false;
}
app.use(cors({
  origin: (origin, callback) => {
    return callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
}));
app.options('*', cors({
  origin: (origin, callback) => {
    return callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

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
app.use('/api/invites', defaultApiLimiter, inviteRoutes);
app.use('/api/admin', defaultApiLimiter, adminRoutes);
app.use('/api/config', defaultApiLimiter, require('./routes/config'));
app.use('/api/bootstrap', defaultApiLimiter, bootstrapRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/dashboard', dashboardRoutes);

// ---- WebSocket Hub Status (admin only) ----
const { authenticate, requireAdmin } = require('./middleware/auth');
app.get('/api/admin/ws-status', authenticate, requireAdmin, (req, res) => {
  res.json({
    ...socketHub.getStatus(),
    catalogWorker: catalogWorker.getStatus(),
    catalogCleanupWorker: catalogCleanupWorker.getStatus(),
    meteoraSnapshotWorker: meteoraSnapshotWorker.getStatus(),
    dexDiscoveryWorker: dexDiscoveryWorker.getStatus(),
  });
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

function bootstrapRuntime(httpServer) {
  if (bootstrapped) {
    return;
  }

  cleanupInterval = setInterval(async () => {
    try {
      const sessions = await Session.cleanup();
      const attempts = await LoginAttempt.cleanup();
      if (sessions > 0 || attempts > 0) {
        console.log(`???? Cleanup: ${sessions} expired sessions, ${attempts} old login attempts`);
      }
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  }, 3600000);

  socketHub.init(httpServer);

  if (config.nodeEnv !== 'test') {
    catalogWorker.start();
    catalogCleanupWorker.start();
    meteoraSnapshotWorker.start();
    dexDiscoveryWorker.start();
  }

  bootstrapped = true;
}

function startServer(port = config.port) {
  if (server?.listening) {
    return server;
  }

  server = http.createServer(app);
  bootstrapRuntime(server);

  server.listen(port, () => {
    console.log('');
    console.log(`???? Volume Alert Server running on port ${port}`);
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
    console.log('   Socket.io on /            ??? Real-time data (cookie session auth)');
    console.log('');
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, get server() { return server; } };
