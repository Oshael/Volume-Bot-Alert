const fs = require('fs');
const path = require('path');

const nodeEnv = process.env.NODE_ENV || 'development';
const defaultEnvPath = path.resolve(__dirname, '../.env');
const testEnvPath = path.resolve(__dirname, '../.env.test');
const resolvedEnvPath = nodeEnv === 'test' && fs.existsSync(testEnvPath)
  ? testEnvPath
  : defaultEnvPath;

require('dotenv').config({ path: resolvedEnvPath });

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'true' || value === '1';
}

function getEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function isLocalTestHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function looksLikeTestDatabaseName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === 'test'
    || normalized.includes('_test')
    || normalized.includes('-test')
    || normalized.startsWith('test_')
    || normalized.startsWith('test-')
    || normalized.includes('testing');
}

function getDbConfig(runtimeEnv) {
  const isTestEnv = runtimeEnv === 'test';
  const hasTestSpecificUrl = Boolean(getEnv('DATABASE_URL_TEST', 'POSTGRES_URL_TEST'));
  const hasTestSpecificParts = Boolean(getEnv(
    'DB_HOST_TEST',
    'PGHOST_TEST',
    'DB_PORT_TEST',
    'PGPORT_TEST',
    'DB_NAME_TEST',
    'PGDATABASE_TEST',
    'DB_USER_TEST',
    'PGUSER_TEST',
    'DB_PASSWORD_TEST',
    'PGPASSWORD_TEST'
  ));
  const preferTestSpecificVars = isTestEnv && (hasTestSpecificUrl || hasTestSpecificParts);
  const connectionString = preferTestSpecificVars
    ? getEnv('DATABASE_URL_TEST', 'POSTGRES_URL_TEST')
    : getEnv('DATABASE_URL', 'POSTGRES_URL');
  let parsed = null;

  if (connectionString) {
    try {
      parsed = new URL(connectionString);
    } catch {
      parsed = null;
    }
  }

  const host = preferTestSpecificVars
    ? getEnv('DB_HOST_TEST', 'PGHOST_TEST') || parsed?.hostname || ''
    : getEnv('DB_HOST', 'PGHOST') || parsed?.hostname || '';
  const port = parseInt(
    (preferTestSpecificVars
      ? getEnv('DB_PORT_TEST', 'PGPORT_TEST')
      : getEnv('DB_PORT', 'PGPORT'))
      || parsed?.port
      || '5432',
    10
  );
  const database = preferTestSpecificVars
    ? getEnv('DB_NAME_TEST', 'PGDATABASE_TEST') || (parsed?.pathname ? parsed.pathname.replace(/^\//, '') : '') || ''
    : getEnv('DB_NAME', 'PGDATABASE') || (parsed?.pathname ? parsed.pathname.replace(/^\//, '') : '') || '';
  const user = preferTestSpecificVars
    ? getEnv('DB_USER_TEST', 'PGUSER_TEST') || (parsed?.username ? decodeURIComponent(parsed.username) : '') || ''
    : getEnv('DB_USER', 'PGUSER') || (parsed?.username ? decodeURIComponent(parsed.username) : '') || '';
  const password = preferTestSpecificVars
    ? getEnv('DB_PASSWORD_TEST', 'PGPASSWORD_TEST') || (parsed?.password ? decodeURIComponent(parsed.password) : '') || ''
    : getEnv('DB_PASSWORD', 'PGPASSWORD') || (parsed?.password ? decodeURIComponent(parsed.password) : '') || '';

  // Useful for managed Postgres providers in production.
  const ssl = parseBoolean(
    preferTestSpecificVars ? getEnv('DB_SSL_TEST') : getEnv('DB_SSL'),
    false
  ) || (preferTestSpecificVars ? getEnv('PGSSLMODE_TEST') : getEnv('PGSSLMODE')) === 'require';
  const sslRejectUnauthorized = parseBoolean(
    preferTestSpecificVars
      ? getEnv('DB_SSL_REJECT_UNAUTHORIZED_TEST')
      : getEnv('DB_SSL_REJECT_UNAUTHORIZED'),
    false
  );

  const explicitTestConfig = isTestEnv && preferTestSpecificVars;

  return {
    host,
    port,
    database,
    user,
    password,
    connectionString,
    ssl,
    sslRejectUnauthorized,
    explicitTestConfig,
  };
}

function validateTestDbTarget(dbConfig) {
  if (nodeEnv !== 'test') {
    return [];
  }

  const errors = [];
  const safeHost = isLocalTestHost(dbConfig.host);
  const safeDatabase = looksLikeTestDatabaseName(dbConfig.database);
  const allowUnsafe = parseBoolean(process.env.ALLOW_UNSAFE_TEST_DATABASE, false);

  if (allowUnsafe) {
    return errors;
  }

  if (!safeHost) {
    errors.push(`Test database host must be local. Current host: ${dbConfig.host || '(empty)'}`);
  }

  if (!safeDatabase) {
    errors.push(`Test database name must clearly be a test DB. Current database: ${dbConfig.database || '(empty)'}`);
  }

  if (!dbConfig.explicitTestConfig && resolvedEnvPath === defaultEnvPath) {
    errors.push('NODE_ENV=test is using .env without explicit *_TEST database variables. Use .env.test or DATABASE_URL_TEST / DB_*_TEST.');
  }

  return errors;
}

const db = getDbConfig(nodeEnv);

const missing = [];
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('CHANGE_ME')) {
  missing.push('JWT_SECRET');
}

const hasDbParts = !!(db.host && db.database && db.user && db.password);
const hasDbUrl = !!db.connectionString;
if (!hasDbParts && !hasDbUrl) {
  missing.push('DB connection (set DB_* / PG* vars or DATABASE_URL)');
}

missing.push(...validateTestDbTarget(db));

if (missing.length > 0) {
  console.error(`Missing required env configuration: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv,
  forceHttps: parseBoolean(process.env.FORCE_HTTPS, false),
  performanceMetrics: {
    enabled: parseBoolean(
      process.env.PERF_METRICS_ENABLED,
      (process.env.NODE_ENV || 'development') === 'development'
    ),
  },

  db: {
    ...db,
    poolMax: parseInt(process.env.DB_POOL_MAX || '20', 10),
    slowQueryLogMs: parseInt(
      process.env.DB_SLOW_QUERY_LOG_MS || (nodeEnv === 'production' ? '2500' : '1000'),
      10
    ),
    logSlowQueries: parseBoolean(process.env.DB_LOG_SLOW_QUERIES, true),
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.AUTH_SESSION_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '365d',
  },

  authCookie: {
    name: process.env.AUTH_COOKIE_NAME || 'volume_alert_session',
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
    secure: parseBoolean(
      process.env.AUTH_COOKIE_SECURE,
      (process.env.NODE_ENV || 'development') === 'production'
    ),
    sameSite: process.env.AUTH_COOKIE_SAMESITE
      || (((process.env.NODE_ENV || 'development') === 'production') ? 'none' : 'lax'),
  },

  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  defaultApiRateLimit: {
    windowMs: parseInt(process.env.DEFAULT_API_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.DEFAULT_API_RATE_LIMIT_MAX_REQUESTS || '180', 10),
  },

  healthRateLimit: {
    windowMs: parseInt(process.env.HEALTH_RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.HEALTH_RATE_LIMIT_MAX_REQUESTS || '30', 10),
  },

  dashboardRateLimit: {
    windowMs: parseInt(process.env.DASHBOARD_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.DASHBOARD_RATE_LIMIT_MAX_REQUESTS || '360', 10),
  },

  pumpfunMetaRateLimit: {
    windowMs: parseInt(process.env.PUMPFUN_META_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.PUMPFUN_META_RATE_LIMIT_MAX_REQUESTS || '220', 10),
  },

  catalogWorker: {
    concurrency: Math.max(1, Math.min(parseInt(process.env.CATALOG_WORKER_CONCURRENCY || '24', 10), 48)),
  },

  catalogWriteRateLimit: {
    windowMs: parseInt(process.env.CATALOG_WRITE_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.CATALOG_WRITE_RATE_LIMIT_MAX_REQUESTS || '60', 10),
  },

  catalogReadRateLimit: {
    windowMs: parseInt(process.env.CATALOG_READ_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.CATALOG_READ_RATE_LIMIT_MAX_REQUESTS || '120', 10),
  },

  authRateLimit: {
    windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || '10', 10),
  },

  authEmailRateLimit: {
    windowMs: parseInt(process.env.AUTH_EMAIL_RATE_LIMIT_WINDOW_MS || '3600000', 10),
    max: parseInt(process.env.AUTH_EMAIL_RATE_LIMIT_MAX_REQUESTS || '6', 10),
  },

  authOtpRateLimit: {
    windowMs: parseInt(process.env.AUTH_OTP_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.AUTH_OTP_RATE_LIMIT_MAX_REQUESTS || '12', 10),
  },

  invite: {
    expiryHours: parseInt(process.env.INVITE_EXPIRY_HOURS || '72', 10),
    maxUses: parseInt(process.env.INVITE_MAX_USES || '1', 10),
  },

  email: {
    enabled: parseBoolean(process.env.EMAIL_ENABLED, false),
    provider: (process.env.EMAIL_PROVIDER || 'resend').trim().toLowerCase(),
    from: (process.env.EMAIL_FROM || '').trim(),
    replyTo: (process.env.EMAIL_REPLY_TO || '').trim() || null,
    appBaseUrl: (process.env.APP_BASE_URL || '').trim(),
    verificationExpiresMinutes: parseInt(process.env.EMAIL_VERIFICATION_EXPIRES_MINUTES || '60', 10),
    passwordResetExpiresMinutes: parseInt(process.env.PASSWORD_RESET_EXPIRES_MINUTES || '30', 10),
    loginOtpExpiresMinutes: parseInt(process.env.LOGIN_OTP_EXPIRES_MINUTES || '10', 10),
    loginOtpLength: parseInt(process.env.LOGIN_OTP_LENGTH || '6', 10),
    loginOtpMaxAttempts: parseInt(process.env.LOGIN_OTP_MAX_ATTEMPTS || '5', 10),
    resend: {
      apiKey: (process.env.RESEND_API_KEY || '').trim(),
    },
    development: {
      capture: parseBoolean(
        process.env.EMAIL_DEV_CAPTURE,
        (process.env.NODE_ENV || 'development') === 'development'
      ),
      fallbackOnFailure: parseBoolean(
        process.env.EMAIL_DEV_FALLBACK_ON_FAILURE,
        (process.env.NODE_ENV || 'development') === 'development'
      ),
      exposeDebug: parseBoolean(
        process.env.EMAIL_DEV_EXPOSE_DEBUG,
        (process.env.NODE_ENV || 'development') === 'development'
      ),
    },
  },

  security: {
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10),
    headersTimeoutMs: parseInt(process.env.HEADERS_TIMEOUT_MS || '20000', 10),
    keepAliveTimeoutMs: parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS || '5000', 10),
    healthCacheMs: parseInt(process.env.HEALTH_CACHE_MS || '5000', 10),
    pumpfunMetaCacheMs: parseInt(process.env.PUMPFUN_META_CACHE_MS || '300000', 10),
    pumpfunMetaFailureCooldownMs: parseInt(process.env.PUMPFUN_META_FAILURE_COOLDOWN_MS || '15000', 10),
    socket: {
      maxConnectionsPerIp: parseInt(process.env.SOCKET_MAX_CONNECTIONS_PER_IP || '12', 10),
      maxSocketsPerSession: parseInt(process.env.SOCKET_MAX_SOCKETS_PER_SESSION || '4', 10),
      maxSubscriptionsPerSocket: parseInt(process.env.SOCKET_MAX_SUBSCRIPTIONS_PER_SOCKET || '250', 10),
      maxHttpBufferSize: parseInt(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || '16384', 10),
      actionWindowMs: parseInt(process.env.SOCKET_ACTION_WINDOW_MS || '10000', 10),
      maxActionsPerWindow: parseInt(process.env.SOCKET_MAX_ACTIONS_PER_WINDOW || '180', 10),
    },
  },

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
