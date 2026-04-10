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

function parseJson(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
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

function normalizeBillingPlans(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const key = String(entry.key || '').trim();
      const label = String(entry.label || '').trim();
      const currencyCode = String(entry.currencyCode || entry.currency || '').trim().toUpperCase();
      const providerPaylinkId = normalizeMoonpayPaylinkId(entry.providerPaylinkId || entry.paylinkId || '');
      const accessDays = Number(entry.accessDays);
      const amountMinor = Number(entry.amountMinor);

      if (!key || !label || !currencyCode || !Number.isFinite(accessDays) || accessDays <= 0 || !Number.isFinite(amountMinor) || amountMinor <= 0) {
        return null;
      }

      return {
        key,
        label,
        description: String(entry.description || '').trim(),
        currencyCode,
        amountMinor: Math.round(amountMinor),
        accessDays: Math.round(accessDays),
        featured: parseBoolean(entry.featured, false),
        providerPaylinkId,
      };
    })
    .filter(Boolean);
}

function normalizeMoonpayPaylinkId(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || raw;
  } catch (_) {
    return raw;
  }
}

function normalizeMoonpayNetwork(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'test' || normalized === 'testnet' || normalized === 'sandbox' || normalized === 'dev' || normalized === 'development') {
    return 'test';
  }
  return 'main';
}

function buildSocialProviderConfig({ clientIdEnv, clientSecretEnv, scopes }) {
  const clientId = String(process.env[clientIdEnv] || '').trim();
  const clientSecret = String(process.env[clientSecretEnv] || '').trim();
  return {
    clientId,
    clientSecret,
    scopes: [...scopes],
    configured: Boolean(clientId && clientSecret),
  };
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getRuntimeRole(runSocketHub, runBackgroundJobs) {
  if (runSocketHub && runBackgroundJobs) {
    return 'combined';
  }
  if (runSocketHub) {
    return 'web';
  }
  if (runBackgroundJobs) {
    return 'background';
  }
  return 'idle';
}

function getDefaultMoonpayApiBaseUrl(network) {
  return network === 'test'
    ? 'https://api.dev.hel.io/v1'
    : 'https://api.hel.io/v1';
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

const TEST_DB_URL_ENV_NAMES = ['DATABASE_URL_TEST', 'POSTGRES_URL_TEST'];
const DEFAULT_DB_URL_ENV_NAMES = ['DATABASE_URL', 'POSTGRES_URL'];
const TEST_DB_PART_ENV_NAMES = [
  'DB_HOST_TEST',
  'PGHOST_TEST',
  'DB_PORT_TEST',
  'PGPORT_TEST',
  'DB_NAME_TEST',
  'PGDATABASE_TEST',
  'DB_USER_TEST',
  'PGUSER_TEST',
  'DB_PASSWORD_TEST',
  'PGPASSWORD_TEST',
];

function parseConnectionUrl(connectionString) {
  if (!connectionString) {
    return null;
  }

  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

function getDbEnvValue(preferTestSpecificVars, testNames, defaultNames) {
  return preferTestSpecificVars
    ? getEnv(...testNames)
    : getEnv(...defaultNames);
}

function resolveDbStringValue(preferTestSpecificVars, testNames, defaultNames, fallback) {
  return getDbEnvValue(preferTestSpecificVars, testNames, defaultNames) || fallback || '';
}

function getParsedConnectionValue(parsed, key) {
  if (!parsed) {
    return '';
  }

  if (key === 'database') {
    return parsed.pathname ? parsed.pathname.replace(/^\//, '') : '';
  }
  if (key === 'user') {
    return parsed.username ? decodeURIComponent(parsed.username) : '';
  }
  if (key === 'password') {
    return parsed.password ? decodeURIComponent(parsed.password) : '';
  }

  return parsed[key] || '';
}

function resolveDbSslConfig(preferTestSpecificVars) {
  const ssl = parseBoolean(
    getDbEnvValue(preferTestSpecificVars, ['DB_SSL_TEST'], ['DB_SSL']),
    false
  ) || getDbEnvValue(preferTestSpecificVars, ['PGSSLMODE_TEST'], ['PGSSLMODE']) === 'require';

  const sslRejectUnauthorized = parseBoolean(
    getDbEnvValue(
      preferTestSpecificVars,
      ['DB_SSL_REJECT_UNAUTHORIZED_TEST'],
      ['DB_SSL_REJECT_UNAUTHORIZED']
    ),
    false
  );

  return {
    ssl,
    sslRejectUnauthorized,
  };
}

function getDbConfig(runtimeEnv) {
  const isTestEnv = runtimeEnv === 'test';
  const hasTestSpecificUrl = Boolean(getEnv(...TEST_DB_URL_ENV_NAMES));
  const hasTestSpecificParts = Boolean(getEnv(...TEST_DB_PART_ENV_NAMES));
  const preferTestSpecificVars = isTestEnv && (hasTestSpecificUrl || hasTestSpecificParts);
  const connectionString = getDbEnvValue(preferTestSpecificVars, TEST_DB_URL_ENV_NAMES, DEFAULT_DB_URL_ENV_NAMES);
  const parsed = parseConnectionUrl(connectionString);

  const host = resolveDbStringValue(
    preferTestSpecificVars,
    ['DB_HOST_TEST', 'PGHOST_TEST'],
    ['DB_HOST', 'PGHOST'],
    getParsedConnectionValue(parsed, 'hostname')
  );
  const port = parseInt(
    getDbEnvValue(preferTestSpecificVars, ['DB_PORT_TEST', 'PGPORT_TEST'], ['DB_PORT', 'PGPORT'])
      || getParsedConnectionValue(parsed, 'port')
      || '5432',
    10
  );
  const database = resolveDbStringValue(
    preferTestSpecificVars,
    ['DB_NAME_TEST', 'PGDATABASE_TEST'],
    ['DB_NAME', 'PGDATABASE'],
    getParsedConnectionValue(parsed, 'database')
  );
  const user = resolveDbStringValue(
    preferTestSpecificVars,
    ['DB_USER_TEST', 'PGUSER_TEST'],
    ['DB_USER', 'PGUSER'],
    getParsedConnectionValue(parsed, 'user')
  );
  const password = resolveDbStringValue(
    preferTestSpecificVars,
    ['DB_PASSWORD_TEST', 'PGPASSWORD_TEST'],
    ['DB_PASSWORD', 'PGPASSWORD'],
    getParsedConnectionValue(parsed, 'password')
  );
  const { ssl, sslRejectUnauthorized } = resolveDbSslConfig(preferTestSpecificVars);

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

const runtime = {
  runSocketHub: nodeEnv !== 'test' && parseBoolean(process.env.RUN_SOCKET_HUB, true),
  runBackgroundJobs: parseBoolean(process.env.RUN_BACKGROUND_JOBS, true),
};

runtime.role = getRuntimeRole(runtime.runSocketHub, runtime.runBackgroundJobs);

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv,
  runtime,
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
    expiresIn: process.env.AUTH_SESSION_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '30d',
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

  preAccessCookie: {
    name: process.env.PRE_ACCESS_COOKIE_NAME || 'volume_alert_pre_access',
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
    secure: parseBoolean(
      process.env.AUTH_COOKIE_SECURE,
      (process.env.NODE_ENV || 'development') === 'production'
    ),
    sameSite: process.env.AUTH_COOKIE_SAMESITE
      || (((process.env.NODE_ENV || 'development') === 'production') ? 'none' : 'lax'),
    expiresMinutes: parseInt(process.env.PRE_ACCESS_EXPIRES_MINUTES || '30', 10),
    returnUrl: (
      process.env.PRE_ACCESS_RETURN_URL
      || ((process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '') ? `${(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '')}/access` : '')
    ).trim(),
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
    max: parseInt(process.env.PUMPFUN_META_RATE_LIMIT_MAX_REQUESTS || '300', 10),
  },

  catalogWorker: {
    concurrency: Math.max(1, Math.min(parseInt(process.env.CATALOG_WORKER_CONCURRENCY || '24', 10), 48)),
  },

  tokenRiskEnrichmentWorker: {
    scanLimit: Math.max(1, Math.min(parseInt(process.env.TOKEN_RISK_ENRICHMENT_SCAN_LIMIT || '120', 10), 5000)),
    batchLimit: Math.max(1, Math.min(parseInt(process.env.TOKEN_RISK_ENRICHMENT_BATCH_LIMIT || '3', 10), 25)),
    freshEnrichmentTtlMs: Math.max(60000, parseInt(process.env.TOKEN_RISK_ENRICHMENT_FRESH_TTL_MS || `${60 * 60 * 1000}`, 10) || (60 * 60 * 1000)),
  },

  tokenRiskReviewSyncWorker: {
    scanLimit: Math.max(1, Math.min(parseInt(process.env.TOKEN_RISK_REVIEW_SYNC_SCAN_LIMIT || '200', 10), 5000)),
    minMcap: Math.max(0, parseInt(process.env.TOKEN_RISK_REVIEW_SYNC_MIN_MCAP || '30000', 10) || 30000),
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

  socialAuth: {
    appBaseUrl: normalizeBaseUrl(process.env.APP_BASE_URL || ''),
    callbackBaseUrl: normalizeBaseUrl(
      process.env.SOCIAL_AUTH_CALLBACK_BASE_URL
      || process.env.API_BASE_URL
      || process.env.APP_BASE_URL
      || ''
    ),
    linkCookie: {
      name: process.env.SOCIAL_LINK_COOKIE_NAME || 'volume_alert_social_link',
      domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
      secure: parseBoolean(
        process.env.AUTH_COOKIE_SECURE,
        (process.env.NODE_ENV || 'development') === 'production'
      ),
      sameSite: process.env.AUTH_COOKIE_SAMESITE
        || (((process.env.NODE_ENV || 'development') === 'production') ? 'none' : 'lax'),
      expiresMinutes: parseInt(process.env.SOCIAL_LINK_EXPIRES_MINUTES || '10', 10),
    },
    loginCookie: {
      name: process.env.SOCIAL_LOGIN_COOKIE_NAME || 'volume_alert_social_login',
      domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
      secure: parseBoolean(
        process.env.AUTH_COOKIE_SECURE,
        (process.env.NODE_ENV || 'development') === 'production'
      ),
      sameSite: process.env.AUTH_COOKIE_SAMESITE
        || (((process.env.NODE_ENV || 'development') === 'production') ? 'none' : 'lax'),
      expiresMinutes: parseInt(process.env.SOCIAL_LOGIN_EXPIRES_MINUTES || '10', 10),
    },
    providers: {
      google: buildSocialProviderConfig({
        clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
        scopes: ['openid', 'email', 'profile'],
      }),
      discord: buildSocialProviderConfig({
        clientIdEnv: 'DISCORD_OAUTH_CLIENT_ID',
        clientSecretEnv: 'DISCORD_OAUTH_CLIENT_SECRET',
        scopes: ['identify', 'email'],
      }),
    },
  },

  billing: {
    enabled: parseBoolean(process.env.BILLING_ENABLED, false),
    checkoutReturnUrl: (process.env.BILLING_CHECKOUT_RETURN_URL || process.env.APP_BASE_URL || '').trim(),
    plans: normalizeBillingPlans(parseJson(process.env.BILLING_PLANS_JSON, [])),
    moonpay: {
      network: normalizeMoonpayNetwork(process.env.MOONPAY_COMMERCE_NETWORK || 'main'),
      apiBaseUrl: (
        process.env.MOONPAY_COMMERCE_API_BASE_URL
        || getDefaultMoonpayApiBaseUrl(normalizeMoonpayNetwork(process.env.MOONPAY_COMMERCE_NETWORK || 'main'))
      ).trim().replace(/\/+$/, ''),
      apiKey: (process.env.MOONPAY_COMMERCE_API_KEY || '').trim(),
      bearerToken: (process.env.MOONPAY_COMMERCE_BEARER_TOKEN || '').trim(),
      webhookTokens: String(process.env.MOONPAY_COMMERCE_WEBHOOK_TOKENS || process.env.MOONPAY_COMMERCE_WEBHOOK_TOKEN || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      mockMode: nodeEnv !== 'production' && parseBoolean(process.env.MOONPAY_COMMERCE_MOCK_MODE, false),
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
      maxSubscriptionsPerSocket: parseInt(process.env.SOCKET_MAX_SUBSCRIPTIONS_PER_SOCKET || '350', 10),
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
