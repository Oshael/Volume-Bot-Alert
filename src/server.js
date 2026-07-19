const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('../config');
const { defaultApiLimiter, healthLimiter } = require('./middleware/rate-limit');
const { isAllowedOrigin, trustProxySetting } = require('./utils/request-security');
const { getSecurityEventStats } = require('./utils/security-events');
const { assertRuntimeSchema } = require('./utils/runtime-schema');
const Session = require('./models/session');
const LoginAttempt = require('./models/login-attempt');
const EmailVerificationToken = require('./models/email-verification-token');
const PasswordResetToken = require('./models/password-reset-token');
const LoginEmailOtpChallenge = require('./models/login-email-otp-challenge');

// Routes
const authRoutes = require('./routes/auth');
const walletAuthRoutes = require('./routes/wallet-auth');
const socialAuthRoutes = require('./routes/social-auth');
const inviteRoutes = require('./routes/invites');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const mockTradingRoutes = require('./routes/mock-trading');
const accountRoutes = require('./routes/account');
const accountSecurityRoutes = require('./routes/account-security');
const billingRoutes = require('./routes/billing');
const preAccessRoutes = require('./routes/pre-access');
const bootstrapRoutes = require('./routes/bootstrap');
const catalogRoutes = require('./routes/catalog');
const dashboardRoutes = require('./routes/dashboard');
const tokenGateRoutes = require('./routes/token-gate');

// Services
const socketHub = require('./services/socket-hub');
const catalogWorker = require('./services/catalog-worker');
const catalogCleanupWorker = require('./services/catalog-cleanup-worker');
const robinhoodRetentionWorker = require('./services/robinhood-retention-worker');
const robinhoodIngestionWorker = require('./services/robinhood-ingestion-worker');
const robinhoodCatalogStagingWorker = require('./services/robinhood-catalog-staging-worker');
const { buildRobinhoodCatalogStagingTelemetry } = robinhoodCatalogStagingWorker;
const robinhoodCatalogProjectionWorker = require('./services/robinhood-catalog-projection-worker');
const { buildRobinhoodCatalogProjectionTelemetry } = robinhoodCatalogProjectionWorker;
const robinhoodRealtimeAlertWorker = require('./services/robinhood-realtime-alert-worker');
const robinhoodLiveCatalogWorker = require('./services/robinhood-live-catalog-worker');
const robinhoodMarketAggregateWorker = require('./services/robinhood-market-aggregate-worker');
const {
  buildRobinhoodLeaseTelemetry,
  buildRobinhoodRolloutStatus,
  evaluateRobinhoodCatalogStagingGate,
  evaluateRobinhoodIngestionGate,
} = require('./services/robinhood-rollout-status');
const meteoraSnapshotWorker = require('./services/meteora-snapshot-worker');
const dexDiscoveryWorker = require('./services/dex-discovery-worker');
const bidZoneWorker = require('./services/bid-zone-worker');
const tokenRiskEnrichmentWorker = require('./services/token-risk-enrichment-worker');
const tokenRiskReviewSyncWorker = require('./services/token-risk-review-sync-worker');
const mockTradingTakeProfitWorker = require('./services/mock-trading-take-profit-worker');
const gmgnDiscoveryWorker = require('./services/gmgn-discovery-worker');
const gmgnClaimSignalWorker = require('./services/gmgn-claim-signal-worker');
const backendAlertRealtime = require('./services/backend-alert-realtime');
const marketBucketRealtime = require('./services/market-bucket-realtime');
const userConfigSync = require('./services/user-config-sync');
const gmgnClient = require('./services/gmgn-client');
const dexscreener = require('./services/dexscreener');
const solUsdPrice = require('./services/sol-usd-price-service');
const { createWorkerLeaseManager } = require('./services/worker-lease-manager');
const workerLease = require('./models/worker-lease');

const ROBINHOOD_INGESTION_LEASE_KEY = 'robinhood-ingestion-worker';
const ROBINHOOD_CATALOG_STAGING_LEASE_KEY = 'robinhood-catalog-staging-worker';
const ROBINHOOD_CATALOG_PROJECTION_LEASE_KEY = 'robinhood-catalog-projection-worker';
const app = express();
let server = null;
let bootstrapped = false;
let startupInFlight = false;
const workerLeaseManager = createWorkerLeaseManager();
const exposedResponseHeaders = [
  'RateLimit',
  'RateLimit-Policy',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
];

// ---- Security middlewares ----
const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  frameSrc: ["'none'"],
  formAction: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  fontSrc: ["'self'", 'data:'],
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
app.use(cors({
  origin: (origin, callback) => {
    return callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
  exposedHeaders: exposedResponseHeaders,
}));
app.options('*', cors({
  origin: (origin, callback) => {
    return callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
  exposedHeaders: exposedResponseHeaders,
}));
// Custom alert rules accept an inline MP3 data URL (5 MB file → ~7 MB base64), so
// that single route gets a larger JSON limit; everything else stays at 1 MB.
const defaultJsonParser = express.json({ limit: '1mb' });
const largeJsonParser = express.json({ limit: '8mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/dashboard/custom-alert-rules') {
    return largeJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});
app.use(cookieParser());

// Trust only local/private proxy hops so direct clients cannot spoof forwarded IPs.
app.set('trust proxy', trustProxySetting);

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
app.use('/api/health', healthLimiter, healthRoutes);
app.use('/api/auth/social', socialAuthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/wallet-auth', walletAuthRoutes);
app.use('/api/invites', defaultApiLimiter, inviteRoutes);
if (config.mockTrading.enabled) {
  app.use('/api/admin/mock-trading', defaultApiLimiter, mockTradingRoutes);
} else {
  app.use('/api/admin/mock-trading', defaultApiLimiter, (_req, res) => {
    res.status(404).json({ error: 'Mock trading is disabled' });
  });
}
app.use('/api/admin', defaultApiLimiter, adminRoutes);
app.use('/api/account', defaultApiLimiter, accountRoutes);
app.use('/api/account-security', defaultApiLimiter, accountSecurityRoutes);
app.use('/api/billing', defaultApiLimiter, billingRoutes);
app.use('/api/token-gate', tokenGateRoutes);
app.use('/api/pre-access', defaultApiLimiter, preAccessRoutes);
app.use('/api/config', defaultApiLimiter, require('./routes/config'));
app.use('/api/bootstrap', defaultApiLimiter, bootstrapRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/dashboard', dashboardRoutes);

// ---- WebSocket Hub Status (admin only) ----
const { authenticate, requireAdmin } = require('./middleware/auth');
app.get('/api/admin/ws-status', authenticate, requireAdmin, async (req, res) => {
  let workerLeases = [];
  let workerLeaseError = null;
  try {
    workerLeases = await workerLease.list();
  } catch (err) {
    workerLeaseError = err.message;
  }
  const robinhoodIngestionLease = workerLeases.find(
    (lease) => lease.key === ROBINHOOD_INGESTION_LEASE_KEY
  ) || null;
  const robinhoodCatalogStagingLease = workerLeases.find(
    (lease) => lease.key === ROBINHOOD_CATALOG_STAGING_LEASE_KEY
  ) || null;
  const robinhoodCatalogProjectionLease = workerLeases.find(
    (lease) => lease.key === ROBINHOOD_CATALOG_PROJECTION_LEASE_KEY
  ) || null;
  const robinhoodIngestionStatus = robinhoodIngestionWorker.getStatus();

  res.json({
    runtime: {
      role: config.runtime.role,
      socketEnabled: Boolean(config.runtime.runSocketHub),
      backgroundJobsEnabled: Boolean(config.runtime.runBackgroundJobs),
      workerGroupsRequested: config.runtime.workerGroupsRequested || [],
      workerGroupsActive: config.runtime.workerGroupsActive || [],
      workerGroupsSkipped: config.runtime.workerGroupsSkipped || [],
    },
    ...socketHub.getStatus(),
    security: getSecurityEventStats(),
    catalogWorker: catalogWorker.getStatus(),
    catalogCleanupWorker: catalogCleanupWorker.getStatus(),
    robinhoodRetentionWorker: robinhoodRetentionWorker.getStatus(),
    robinhoodIngestionWorker: {
      ...robinhoodIngestionStatus,
      sharedLease: robinhoodIngestionLease,
    },
    robinhoodCatalogStagingWorker: {
      ...robinhoodCatalogStagingWorker.getStatus(),
      sharedLease: robinhoodCatalogStagingLease,
    },
    robinhoodCatalogProjectionWorker: {
      ...robinhoodCatalogProjectionWorker.getStatus(),
      sharedLease: robinhoodCatalogProjectionLease,
    },
    robinhoodLiveCatalogWorker: robinhoodLiveCatalogWorker.getStatus(),
    robinhoodRealtimeAlertWorker: robinhoodRealtimeAlertWorker.getStatus(),
    robinhoodMarketAggregateWorker: robinhoodMarketAggregateWorker.getStatus(),
    robinhoodRollout: buildRobinhoodRolloutStatus({
      config,
      ingestionStatus: robinhoodIngestionStatus,
      sharedLease: robinhoodIngestionLease,
    }),
    meteoraSnapshotWorker: meteoraSnapshotWorker.getStatus(),
    dexDiscoveryWorker: dexDiscoveryWorker.getStatus(),
    bidZoneWorker: bidZoneWorker.getStatus(),
    tokenRiskEnrichmentWorker: tokenRiskEnrichmentWorker.getStatus(),
    tokenRiskReviewSyncWorker: tokenRiskReviewSyncWorker.getStatus(),
    mockTradingTakeProfitWorker: mockTradingTakeProfitWorker.getStatus(),
    solUsdPrice: solUsdPrice.getStatus(),
    gmgnDiscoveryWorker: gmgnDiscoveryWorker.getStatus(),
    gmgnClaimSignalWorker: gmgnClaimSignalWorker.getStatus(),
    workerLeases,
    workerLeaseProcess: workerLeaseManager.getStatus(),
    workerLeaseError,
    gmgn: gmgnClient.getStatus(),
    dexscreener: dexscreener.getCacheStats(),
  });
});

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---- Global error handler ----
app.use((err, req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

function bootstrapRuntime(httpServer) {
  if (bootstrapped) {
    return;
  }

  bootstrapWebRuntime(httpServer);
  bootstrapSolUsdPriceRuntime();
  bootstrapBackgroundRuntime();

  bootstrapped = true;
}

function bootstrapSolUsdPriceRuntime() {
  if (config.nodeEnv === 'test') {
    return;
  }

  solUsdPrice.start().catch((err) => {
    console.error('[SOL/USD] Failed to start CoinMarketCap price service:', err.message);
  });
}

async function runCleanupCycle() {
  const sessions = await Session.cleanup();
  const attempts = await LoginAttempt.cleanup();
  const loginOtps = await LoginEmailOtpChallenge.cleanup();
  const emailVerifications = await EmailVerificationToken.cleanupExpired();
  const passwordResets = await PasswordResetToken.cleanupExpired();

  if (sessions > 0 || attempts > 0 || loginOtps > 0 || emailVerifications > 0 || passwordResets > 0) {
    console.log(
      `???? Cleanup: ${sessions} expired sessions, ${attempts} old login attempts, ${loginOtps} OTP challenges, ${emailVerifications} email verification tokens, ${passwordResets} password reset tokens`
    );
  }
}

function shouldBootstrapWebRuntime() {
  return config.nodeEnv !== 'test' && config.runtime.runSocketHub;
}

function shouldBootstrapBackgroundRuntime() {
  return config.runtime.runBackgroundJobs;
}

function shouldStartWorkerSet() {
  return config.nodeEnv !== 'test' && shouldBootstrapBackgroundRuntime();
}

function startBackgroundCleanup() {
  setInterval(async () => {
    try {
      await runCleanupCycle();
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  }, 3600000);
}

function hasWorkerGroup(group) {
  return (config.runtime.workerGroupsActive || []).includes(group);
}

function startLockedWorker(group, key, label, start, options = {}) {
  workerLeaseManager.start({
    key,
    label,
    metadata: {
      group,
      runtimeRole: config.runtime.role,
    },
    metadataProvider: options.metadataProvider,
    start,
  });
}

function startWorkerSet() {
  if (hasWorkerGroup('core')) {
    startLockedWorker('core', 'user-config-sync', 'User config sync', () => userConfigSync.start());
    startLockedWorker('core', 'catalog-worker', 'Catalog worker', () => catalogWorker.start());
    startLockedWorker('core', 'dex-discovery-worker', 'Dex discovery worker', () => dexDiscoveryWorker.start());
    startLockedWorker('core', 'token-risk-enrichment-worker', 'Token risk enrichment worker', () => {
      tokenRiskEnrichmentWorker.start(config.tokenRiskEnrichmentWorker);
    });
    startLockedWorker('core', 'token-risk-review-sync-worker', 'Token risk review sync worker', () => {
      tokenRiskReviewSyncWorker.start(config.tokenRiskReviewSyncWorker);
    });
  }

  if (hasWorkerGroup('market')) {
    startLockedWorker('market', 'meteora-snapshot-worker', 'Meteora snapshot worker', () => {
      meteoraSnapshotWorker.start();
    });
    if (config.bidZoneWorker.enabled) {
      startLockedWorker('market', 'bid-zone-worker', 'Bid-zone worker', () => {
        bidZoneWorker.start(config.bidZoneWorker);
      });
    }
    startLockedWorker('market', 'gmgn-discovery-worker', 'GMGN discovery worker', () => {
      gmgnDiscoveryWorker.start(config.gmgnDiscoveryWorker);
    });
    startLockedWorker('market', 'gmgn-claim-signal-worker', 'GMGN claim signal worker', () => {
      gmgnClaimSignalWorker.start(config.gmgnClaimSignalWorker);
    });
  }

  if (hasWorkerGroup('maintenance')) {
    startLockedWorker('maintenance', 'catalog-cleanup-worker', 'Catalog cleanup worker', () => {
      catalogCleanupWorker.start();
    });
    if (config.robinhoodRetentionWorker.enabled) {
      startLockedWorker('maintenance', 'robinhood-retention-worker', 'Robinhood retention worker', () => {
        robinhoodRetentionWorker.start(config.robinhoodRetentionWorker);
      });
    }
    startLockedWorker('maintenance', 'mock-trading-take-profit-worker', 'Mock trading take-profit worker', () => {
      mockTradingTakeProfitWorker.start(config.mockTradingTakeProfitWorker);
    });
  }

  if (hasWorkerGroup('robinhood')) {
    const ingestionGate = evaluateRobinhoodIngestionGate(config);
    if (ingestionGate.allowed) {
      startLockedWorker('robinhood', ROBINHOOD_INGESTION_LEASE_KEY, 'Robinhood ingestion worker', () => {
        robinhoodLiveCatalogWorker.start({ enabled: true });
        robinhoodMarketAggregateWorker.start(config.robinhoodMarketAggregateWorker);
        robinhoodRealtimeAlertWorker.start({
          enabled: true,
          signalConfig: config.robinhoodSignalDryRun,
          statementTimeoutMs: 1500,
          rolloutProvider: () => {
            const rollout = buildRobinhoodRolloutStatus({
              config,
              ingestionStatus: robinhoodIngestionWorker.getStatus(),
            });
            return {
              alertsRequested: rollout.axes.alerts.requested,
              publishable: rollout.publishable,
            };
          },
        });
        robinhoodIngestionWorker.start({
          ...config.robinhoodIngestionWorker,
          socialMetadataEnabled: false,
          emitMarketBucketUpdate: (payload) => {
            const socketEmitted = socketHub.emitMarketBucketUpdate(payload);
            const relayQueued = socketEmitted || marketBucketRealtime.enqueue(payload);
            const catalogQueued = robinhoodLiveCatalogWorker.enqueue(payload);
            const alertQueued = robinhoodRealtimeAlertWorker.enqueue(payload);
            const aggregateQueued = robinhoodMarketAggregateWorker.enqueue(payload);
            return socketEmitted || relayQueued || catalogQueued || alertQueued || aggregateQueued;
          },
          onFatal: (error) => workerLeaseManager.halt(ROBINHOOD_INGESTION_LEASE_KEY, error),
        });
      }, {
        metadataProvider: () => ({
          telemetry: buildRobinhoodLeaseTelemetry({
            ingestionStatus: robinhoodIngestionWorker.getStatus(),
            confirmations: config.robinhoodIngestionWorker.confirmations,
          }),
        }),
      });

      startLockedWorker(
        'robinhood',
        ROBINHOOD_CATALOG_PROJECTION_LEASE_KEY,
        'Robinhood catalog projection worker',
        () => robinhoodCatalogProjectionWorker.start({
          ...config.robinhoodCatalogProjectionWorker,
          enabled: true,
          rpcOptions: config.robinhoodIngestionWorker,
        }),
        {
          metadataProvider: () => ({
            telemetry: buildRobinhoodCatalogProjectionTelemetry(
              robinhoodCatalogProjectionWorker.getStatus()
            ),
          }),
        }
      );
    } else {
      console.warn(
        `[RobinhoodIngestionWorker] Group selected but rollout gate is closed: ${ingestionGate.blockers.join(', ')}.`
      );
    }

    const stagingGate = evaluateRobinhoodCatalogStagingGate(config);
    if (stagingGate.allowed) {
      startLockedWorker(
        'robinhood',
        ROBINHOOD_CATALOG_STAGING_LEASE_KEY,
        'Robinhood catalog staging worker',
        () => robinhoodCatalogStagingWorker.start({
          enabled: true,
          signalConfig: config.robinhoodSignalDryRun,
          candidateLimit: config.robinhoodSignalDryRun.candidateLimit,
          statementTimeoutMs: config.robinhoodSignalDryRun.statementTimeoutMs,
          rolloutProvider: () => {
            const rollout = buildRobinhoodRolloutStatus({
              config,
              ingestionStatus: robinhoodIngestionWorker.getStatus(),
            });
            return {
              alertsRequested: rollout.axes.alerts.requested,
              publishable: rollout.publishable,
            };
          },
        }),
        {
          metadataProvider: () => ({
            telemetry: buildRobinhoodCatalogStagingTelemetry(
              robinhoodCatalogStagingWorker.getStatus()
            ),
          }),
        }
      );
    } else if (stagingGate.alertsRequested) {
      console.warn(
        `[RobinhoodCatalogStagingWorker] Alert intent is set but staging gate is closed: ${stagingGate.blockers.join(', ')}.`
      );
    }
  }
}

function bootstrapWebRuntime(httpServer) {
  if (!shouldBootstrapWebRuntime()) {
    return;
  }

  socketHub.init(httpServer);
  backendAlertRealtime.start().catch((err) => {
    console.error('[BackendAlertRealtime] Failed to start listener:', err.message);
  });
  marketBucketRealtime.start().catch((err) => {
    console.error('[MarketBucketRealtime] Failed to start listener:', err.message);
  });
}

function bootstrapBackgroundRuntime() {
  if (!shouldBootstrapBackgroundRuntime()) {
    return;
  }

  if (config.nodeEnv !== 'test' && hasWorkerGroup('core')) {
    startBackgroundCleanup();
  }

  if (shouldStartWorkerSet()) {
    startWorkerSet();
  }
}

function startServer(port = config.port) {
  if (server?.listening || startupInFlight) {
    return server;
  }

  server = http.createServer(app);
  server.requestTimeout = Math.max(1000, Number(config.security?.requestTimeoutMs) || 15000);
  server.headersTimeout = Math.max(server.requestTimeout + 1000, Number(config.security?.headersTimeoutMs) || 20000);
  server.keepAliveTimeout = Math.max(1000, Number(config.security?.keepAliveTimeoutMs) || 5000);
  startupInFlight = true;

  assertRuntimeSchema({ profile: config.nodeEnv === 'test' ? 'test' : 'runtime' })
    .then(() => {
      bootstrapRuntime(server);

      server.listen(port, () => {
        startupInFlight = false;
        console.log('');
        console.log(`???? Volume Alert Server running on port ${port}`);
        console.log(`   Environment: ${config.nodeEnv}`);
        console.log(`   Runtime: socket=${config.runtime.runSocketHub ? 'on' : 'off'} background=${config.runtime.runBackgroundJobs ? 'on' : 'off'}`);
        console.log(`   Worker groups: ${(config.runtime.workerGroupsActive || []).join(', ') || 'none'}`);
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
        console.log('   POST /api/admin/token-risk-enrichment/runs ??? Trigger token risk enrichment batch');
        console.log('   --- WebSocket ---');
        console.log('   Socket.io on /            ??? Real-time data (cookie session auth)');
        console.log('');
      });
    })
    .catch((err) => {
      startupInFlight = false;
      console.error('');
      console.error(err?.message || err);
      console.error('');
      try {
        server?.close();
      } catch (_) {}
      server = null;

      if (config.nodeEnv === 'test') {
        setImmediate(() => { throw err; });
        return;
      }

      process.exit(1);
    });

  return server;
}

let shutdownInFlight = false;

async function shutdownGracefully(signal = 'SIGTERM') {
  if (shutdownInFlight) {
    return;
  }
  shutdownInFlight = true;

  console.log(`[Shutdown] Received ${signal}; releasing worker leases...`);
  const forceExitTimer = setTimeout(() => {
    console.error('[Shutdown] Timed out; forcing exit.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref?.();

  try {
    await Promise.all([
      robinhoodIngestionWorker.stop(),
      robinhoodCatalogStagingWorker.stop(),
      robinhoodCatalogProjectionWorker.stop(),
      robinhoodLiveCatalogWorker.stop(),
      robinhoodRealtimeAlertWorker.stop(),
      robinhoodMarketAggregateWorker.stop(),
    ]);
    const releaseResult = await workerLeaseManager.stop({ releaseLeases: true });
    console.log(`[Shutdown] Worker leases released=${releaseResult.released} missed=${releaseResult.missed} errors=${releaseResult.errors}`);
  } catch (err) {
    console.error('[Shutdown] Failed to release worker leases:', err.message);
  }

  if (server?.listening) {
    server.close(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
    return;
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

if (require.main === module) {
  startServer();
  process.once('SIGINT', () => {
    void shutdownGracefully('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdownGracefully('SIGTERM');
  });
}

module.exports = {
  app,
  startServer,
  shutdownGracefully,
  get server() { return server; },
};
