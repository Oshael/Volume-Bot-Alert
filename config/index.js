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
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

function parseIntegerInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

function parseOptionalTimestamp(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseOptionalBlock(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized) && !/^0x[0-9a-f]+$/i.test(normalized)) return null;
  return normalized;
}

function parseOptionalNonNegativeInteger(value, { positive = false } = {}) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0)) return null;
  return parsed;
}

function parseOptionalNonNegativeDecimal(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : null;
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

function hasValidBillingPlanFields({ key, label, currencyCode, accessDays, amountMinor }) {
  return Boolean(
    key
    && label
    && currencyCode
    && Number.isFinite(accessDays)
    && accessDays > 0
    && Number.isFinite(amountMinor)
    && amountMinor > 0
  );
}

function normalizeBillingPlan(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const key = String(entry.key || '').trim();
  const label = String(entry.label || '').trim();
  const currencyCode = String(entry.currencyCode || entry.currency || '').trim().toUpperCase();
  const accessDays = Number(entry.accessDays);
  const amountMinor = Number(entry.amountMinor);
  const providerPaylinkDynamic = parseBoolean(
    entry.providerPaylinkDynamic ?? entry.paylinkDynamic ?? entry.dynamicPaylink,
    false
  );

  if (!hasValidBillingPlanFields({ key, label, currencyCode, accessDays, amountMinor })) {
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
    providerPaylinkId: normalizeMoonpayPaylinkId(entry.providerPaylinkId || entry.paylinkId || ''),
    providerPaylinkDynamic,
    discountProviderPaylinkId: normalizeMoonpayPaylinkId(
      entry.discountProviderPaylinkId || entry.discountPaylinkId || ''
    ),
  };
}

function normalizeBillingPlans(value) {
  return Array.isArray(value) ? value.map(normalizeBillingPlan).filter(Boolean) : [];
}

function normalizeTokenGateTierName(value, discountPercent) {
  const raw = String(value || '').trim().toLowerCase();
  const fallback = `discount_${discountPercent}`;
  if (!raw) {
    return fallback;
  }
  const normalized = raw.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return normalized || fallback;
}

function compareWholeTokenStringsDesc(left, right) {
  const leftValue = BigInt(left.threshold);
  const rightValue = BigInt(right.threshold);
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? -1 : 1;
}

function normalizeTokenGateDiscountTier(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const threshold = String(entry.threshold || entry.discountThreshold || '').trim();
  const discountPercent = parseIntegerInRange(entry.discountPercent ?? entry.percent, 0, 0, 100);
  if (!/^\d+$/.test(threshold) || BigInt(threshold) <= 0n || discountPercent <= 0) {
    return null;
  }

  return {
    threshold,
    discountPercent,
    tier: normalizeTokenGateTierName(entry.tier, discountPercent),
  };
}

function normalizeTokenGateDiscountTiers(value, fallbackThreshold, fallbackPercent) {
  const parsedTiers = Array.isArray(value)
    ? value.map(normalizeTokenGateDiscountTier).filter(Boolean)
    : [];

  if (parsedTiers.length > 0) {
    return parsedTiers.sort(compareWholeTokenStringsDesc);
  }

  const threshold = String(fallbackThreshold || '').trim();
  const discountPercent = parseIntegerInRange(fallbackPercent, 50, 0, 100);
  if (!/^\d+$/.test(threshold) || BigInt(threshold) <= 0n || discountPercent <= 0) {
    return [];
  }

  return [{
    threshold,
    discountPercent,
    tier: normalizeTokenGateTierName('', discountPercent),
  }];
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

const SHARED_WORKER_GROUPS = Object.freeze(['core', 'market', 'maintenance']);
const ISOLATED_WORKER_GROUPS = Object.freeze(['robinhood', 'robinhood-backfill']);
const WORKER_GROUPS = Object.freeze([...SHARED_WORKER_GROUPS, ...ISOLATED_WORKER_GROUPS]);
const WORKER_GROUP_SET = new Set(WORKER_GROUPS);

function normalizeWorkerGroups(value) {
  const raw = String(value || 'all').trim();
  const requested = raw
    ? raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : ['all'];
  const uniqueRequested = [...new Set(requested.length ? requested : ['all'])];
  const invalid = uniqueRequested.filter((group) => group !== 'all' && !WORKER_GROUP_SET.has(group));
  const isolatedRequested = uniqueRequested.filter((group) => ISOLATED_WORKER_GROUPS.includes(group));
  const isolationConflict = isolatedRequested.length > 0 && uniqueRequested.length > 1;
  const active = uniqueRequested.includes('all')
    ? [...SHARED_WORKER_GROUPS]
    : uniqueRequested.filter((group) => WORKER_GROUP_SET.has(group));

  return {
    requested: uniqueRequested,
    active,
    skipped: WORKER_GROUPS.filter((group) => !active.includes(group)),
    invalid,
    isolationConflict,
  };
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
const workerGroups = normalizeWorkerGroups(process.env.BACKGROUND_WORKER_GROUPS);

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
if (workerGroups.invalid.length > 0) {
  missing.push(`BACKGROUND_WORKER_GROUPS invalid values: ${workerGroups.invalid.join(', ')}`);
}
if (workerGroups.isolationConflict) {
  missing.push('BACKGROUND_WORKER_GROUPS cannot combine isolated worker groups with other groups or all');
}

if (missing.length > 0) {
  console.error(`Missing required env configuration: ${missing.join(', ')}`);
  process.exit(1);
}

const runtime = {
  runSocketHub: nodeEnv !== 'test' && parseBoolean(process.env.RUN_SOCKET_HUB, true),
  runBackgroundJobs: parseBoolean(process.env.RUN_BACKGROUND_JOBS, true),
};

runtime.role = getRuntimeRole(runtime.runSocketHub, runtime.runBackgroundJobs);
runtime.workerGroupsRequested = workerGroups.requested;
runtime.workerGroupsActive = workerGroups.active;
runtime.workerGroupsSkipped = workerGroups.skipped;

const robinhoodIngestionEnabled = parseBoolean(process.env.ROBINHOOD_INGESTION_ENABLED, false);
const robinhoodRpcMinIntervalMs = parseIntegerInRange(
  process.env.ROBINHOOD_RPC_MIN_INTERVAL_MS,
  250,
  0,
  60_000
);
const robinhoodArchiveRpcMinIntervalMs = parseIntegerInRange(
  process.env.ROBINHOOD_ARCHIVE_RPC_MIN_INTERVAL_MS,
  robinhoodRpcMinIntervalMs,
  0,
  60_000
);
const robinhoodMaxRangesPerPoll = parseIntegerInRange(
  process.env.ROBINHOOD_MAX_RANGES_PER_POLL,
  20,
  1,
  1000
);
const robinhoodRollout = {
  transport: {
    enabled: parseBoolean(
      process.env.ROBINHOOD_TRANSPORT_ENABLED,
      robinhoodIngestionEnabled
    ),
    explicit: String(process.env.ROBINHOOD_TRANSPORT_ENABLED ?? '').trim() !== '',
  },
  persistence: {
    enabled: parseBoolean(
      process.env.ROBINHOOD_PERSISTENCE_ENABLED,
      robinhoodIngestionEnabled
    ),
    explicit: String(process.env.ROBINHOOD_PERSISTENCE_ENABLED ?? '').trim() !== '',
  },
  alerts: {
    requested: parseBoolean(process.env.ROBINHOOD_ALERTS_ENABLED, false),
    explicit: String(process.env.ROBINHOOD_ALERTS_ENABLED ?? '').trim() !== '',
  },
};

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
    uiMeteoraSummaryCacheMs: parseInt(process.env.DB_UI_METEORA_SUMMARY_CACHE_MS || '12000', 10),
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

  marketTickerRateLimit: {
    windowMs: parseInt(process.env.MARKET_TICKER_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.MARKET_TICKER_RATE_LIMIT_MAX_REQUESTS || '240', 10),
  },

  pumpfunMetaRateLimit: {
    windowMs: parseInt(process.env.PUMPFUN_META_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.PUMPFUN_META_RATE_LIMIT_MAX_REQUESTS || '300', 10),
  },

  catalogWorker: {
    concurrency: Math.max(1, Math.min(parseInt(process.env.CATALOG_WORKER_CONCURRENCY || '24', 10), 48)),
    loopIntervalMs: parseIntegerInRange(process.env.CATALOG_WORKER_LOOP_INTERVAL_MS, 2000, 1000, 60000),
    tokenBudgetPerCycle: parseIntegerInRange(process.env.CATALOG_WORKER_TOKEN_BUDGET_PER_CYCLE, 300, 1, 300),
    distributedClaimEnabled: parseBoolean(process.env.CATALOG_WORKER_DISTRIBUTED_CLAIM_ENABLED, false),
    distributedClaimTtlMs: parseIntegerInRange(process.env.CATALOG_WORKER_DISTRIBUTED_CLAIM_TTL_MS, 120000, 1000, 600000),
    spamTickerDenylist: (process.env.CATALOG_WORKER_SPAM_TICKER_DENYLIST || '')
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
    spamTickerMaxAgeMs: parseIntegerInRange(process.env.CATALOG_WORKER_SPAM_TICKER_MAX_AGE_MS, 600000, 60000, 21600000),
    spamTickerMinMcapUsd: parseIntegerInRange(process.env.CATALOG_WORKER_SPAM_TICKER_MIN_MCAP_USD, 500000, 0, 100000000),
  },

  marketBuckets: {
    aggregateOnWriteEnabled: parseBoolean(process.env.MARKET_BUCKET_AGGREGATE_ON_WRITE_ENABLED, true),
  },

  tokenGate: {
    enabled: parseBoolean(process.env.TOKEN_GATE_ENABLED, false),
    chain: (process.env.TOKEN_GATE_CHAIN || 'solana').trim().toLowerCase(),
    mintAddress: (process.env.TOKEN_GATE_MINT_ADDRESS || '').trim(),
    rpcProvider: (process.env.TOKEN_GATE_RPC_PROVIDER || 'helius').trim().toLowerCase(),
    balanceCacheSeconds: Math.max(1, parseInt(process.env.TOKEN_GATE_BALANCE_CACHE_SECONDS || '60', 10) || 60),
    rpcFailureGraceSeconds: Math.max(
      60,
      parseInt(process.env.TOKEN_GATE_RPC_FAILURE_GRACE_SECONDS || '3600', 10) || 3600
    ),
    unlimitedThreshold: String(process.env.TOKEN_GATE_UNLIMITED_THRESHOLD || '2000000').trim(),
    discountThreshold: String(process.env.TOKEN_GATE_DISCOUNT_THRESHOLD || '1000000').trim(),
    discountPercent: parseIntegerInRange(process.env.TOKEN_GATE_DISCOUNT_PERCENT, 50, 0, 100),
    discountTiers: normalizeTokenGateDiscountTiers(
      parseJson(process.env.TOKEN_GATE_DISCOUNT_TIERS_JSON, null),
      process.env.TOKEN_GATE_DISCOUNT_THRESHOLD || '1000000',
      process.env.TOKEN_GATE_DISCOUNT_PERCENT
    ),
    launchPromo: {
      enabled: parseBoolean(process.env.TOKEN_GATE_LAUNCH_PROMO_ENABLED, true),
      startAt: parseOptionalTimestamp(process.env.TOKEN_GATE_LAUNCH_PROMO_START_AT),
      endAt: parseOptionalTimestamp(process.env.TOKEN_GATE_LAUNCH_PROMO_END_AT),
      threshold: String(process.env.TOKEN_GATE_LAUNCH_PROMO_THRESHOLD || '100000').trim(),
    },
    webhookTokens: String(process.env.HELIUS_WEBHOOK_TOKENS || process.env.HELIUS_WEBHOOK_TOKEN || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    heliusWebhook: {
      enabled: parseBoolean(process.env.HELIUS_TOKEN_GATE_WEBHOOK_SYNC_ENABLED, false),
      id: String(process.env.HELIUS_TOKEN_GATE_WEBHOOK_ID || '').trim(),
      url: String(process.env.HELIUS_TOKEN_GATE_WEBHOOK_URL || '').trim(),
      apiBaseUrl: String(process.env.HELIUS_WEBHOOK_API_BASE_URL || 'https://mainnet.helius-rpc.com').trim(),
      transactionTypes: String(process.env.HELIUS_TOKEN_GATE_WEBHOOK_TRANSACTION_TYPES || 'TRANSFER')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },
  },

  bidZoneWorker: {
    enabled: parseBoolean(process.env.BID_ZONE_WORKER_ENABLED, false),
    runOnStart: parseBoolean(process.env.BID_ZONE_WORKER_RUN_ON_START, false),
    statementTimeoutMs: Math.max(1000, parseInt(process.env.BID_ZONE_STATEMENT_TIMEOUT_MS || '15000', 10) || 15000),
    candidateScanLimit: Math.max(50, Math.min(parseInt(process.env.BID_ZONE_CANDIDATE_SCAN_LIMIT || '400', 10) || 400, 5000)),
  },

  pumpfunPreMigrationCapture: {
    enabled: parseBoolean(process.env.PUMPFUN_PRE_MIGRATION_CAPTURE_ENABLED, false),
    maxTracked: Math.max(1, Math.min(parseInt(process.env.PUMPFUN_PRE_MIGRATION_MAX_TRACKED || '250', 10) || 250, 2000)),
    trackTtlMs: Math.max(60000, parseInt(process.env.PUMPFUN_PRE_MIGRATION_TRACK_TTL_MS || `${2 * 60 * 60 * 1000}`, 10) || (2 * 60 * 60 * 1000)),
  },

  tokenRiskEnrichmentWorker: {
    scanLimit: Math.max(1, Math.min(parseInt(process.env.TOKEN_RISK_ENRICHMENT_SCAN_LIMIT || '120', 10), 5000)),
    batchLimit: Math.max(1, Math.min(parseInt(process.env.TOKEN_RISK_ENRICHMENT_BATCH_LIMIT || '3', 10), 25)),
    freshEnrichmentTtlMs: Math.max(60000, parseInt(process.env.TOKEN_RISK_ENRICHMENT_FRESH_TTL_MS || `${60 * 60 * 1000}`, 10) || (60 * 60 * 1000)),
  },

  tokenRiskReviewSyncWorker: {
    scanLimit: Math.max(1, Math.min(parseInt(process.env.TOKEN_RISK_REVIEW_SYNC_SCAN_LIMIT || '200', 10), 5000)),
    minMcap: Math.max(0, parseInt(process.env.TOKEN_RISK_REVIEW_SYNC_MIN_MCAP || '15000', 10) || 15000),
  },

  mockTradingTakeProfitWorker: {
    enabled: parseBoolean(process.env.MOCK_TRADING_ENABLED, true)
      && parseBoolean(process.env.MOCK_TRADING_TAKE_PROFIT_ENABLED, true),
    intervalMs: Math.max(1000, parseInt(process.env.MOCK_TRADING_TAKE_PROFIT_INTERVAL_MS || '3000', 10) || 3000),
    batchLimit: Math.max(1, Math.min(parseInt(process.env.MOCK_TRADING_TAKE_PROFIT_BATCH_LIMIT || '25', 10) || 25, 100)),
  },

  robinhoodRetentionWorker: {
    enabled: parseBoolean(process.env.ROBINHOOD_RETENTION_ENABLED, true),
    intervalMs: parseIntegerInRange(process.env.ROBINHOOD_RETENTION_INTERVAL_MS, 60 * 1000, 10_000, 60 * 60 * 1000),
    batchLimit: parseIntegerInRange(process.env.ROBINHOOD_RETENTION_BATCH_LIMIT, 2000, 100, 10_000),
    maxBatches: parseIntegerInRange(process.env.ROBINHOOD_RETENTION_MAX_BATCHES, 5, 1, 50),
    statementTimeoutMs: parseIntegerInRange(
      process.env.ROBINHOOD_RETENTION_STATEMENT_TIMEOUT_MS,
      10 * 1000,
      1000,
      60 * 1000
    ),
    verifiedCoverage: {
      from: process.env.ROBINHOOD_MARKET_AGGREGATE_VERIFIED_FROM || null,
      through: process.env.ROBINHOOD_MARKET_AGGREGATE_VERIFIED_THROUGH || null,
    },
  },
  robinhoodMarketAggregateWorker: {
    enabled: parseBoolean(process.env.ROBINHOOD_MARKET_AGGREGATES_ENABLED, true),
  },

  robinhoodMarketAggregateReader: {
    enabled: parseBoolean(process.env.ROBINHOOD_MARKET_AGGREGATE_READS_ENABLED, false),
    shadowCompareEnabled: parseBoolean(
      process.env.ROBINHOOD_MARKET_AGGREGATE_SHADOW_COMPARE_ENABLED,
      false
    ),
    fallbackEnabled: parseBoolean(
      process.env.ROBINHOOD_MARKET_AGGREGATE_FALLBACK_ENABLED,
      true
    ),
    verifiedFrom: process.env.ROBINHOOD_MARKET_AGGREGATE_VERIFIED_FROM || null,
    verifiedThrough: process.env.ROBINHOOD_MARKET_AGGREGATE_VERIFIED_THROUGH || null,
  },

  robinhoodUserVisibility: {
    enabled: parseBoolean(process.env.ROBINHOOD_USER_VISIBILITY_ENABLED, false),
  },

  robinhoodCatalogProjectionWorker: {
    intervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_CATALOG_PROJECTION_INTERVAL_MS,
      60_000,
      60_000,
      60 * 60 * 1000
    ),
    blockscoutBatchSize: parseIntegerInRange(
      process.env.ROBINHOOD_BLOCKSCOUT_METADATA_BATCH_SIZE, 10, 1, 50
    ),
    socialMetadataEnabled: parseBoolean(process.env.ROBINHOOD_SOCIAL_METADATA_ENABLED, true),
    socialBatchSize: parseIntegerInRange(
      process.env.ROBINHOOD_SOCIAL_METADATA_BATCH_SIZE, 5, 1, 5
    ),
    socialDrainIntervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_SOCIAL_METADATA_INTERVAL_MS, 60_000, 60_000, 60 * 60 * 1000
    ),
  },

  robinhoodIngestionWorker: {
    enabled: robinhoodIngestionEnabled,
    publicRpcUrl: String(
      process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
    ).trim(),
    alchemyRpcUrl: String(process.env.ROBINHOOD_ALCHEMY_RPC_URL || '').trim(),
    useAlchemy: parseBoolean(process.env.ROBINHOOD_USE_ALCHEMY, false),
    drpcRpcUrl: String(process.env.ROBINHOOD_DRPC_RPC_URL || '').trim(),
    useDrpc: parseBoolean(process.env.ROBINHOOD_USE_DRPC, false),
    fallbackOrder: String(process.env.ROBINHOOD_FALLBACK_ORDER || 'drpc,alchemy').trim(),
    socialMetadataEnabled: parseBoolean(process.env.ROBINHOOD_SOCIAL_METADATA_ENABLED, false),
    pollIntervalMs: parseIntegerInRange(process.env.ROBINHOOD_POLL_INTERVAL_MS, 2000, 250, 300_000),
    maxErrorBackoffMs: parseIntegerInRange(
      process.env.ROBINHOOD_MAX_ERROR_BACKOFF_MS,
      30_000,
      1000,
      300_000
    ),
    rpcTimeoutMs: parseIntegerInRange(process.env.ROBINHOOD_RPC_TIMEOUT_MS, 15_000, 1000, 60_000),
    rpcMaxRetries: parseIntegerInRange(process.env.ROBINHOOD_RPC_MAX_RETRIES, 1, 0, 5),
    rpcMinIntervalMs: robinhoodRpcMinIntervalMs,
    archiveRpcMinIntervalMs: robinhoodArchiveRpcMinIntervalMs,
    lookbackBlocks: parseIntegerInRange(process.env.ROBINHOOD_LOOKBACK_BLOCKS, 250, 1, 100_000),
    startBlock: parseOptionalBlock(process.env.ROBINHOOD_START_BLOCK),
    confirmations: parseIntegerInRange(process.env.ROBINHOOD_CONFIRMATIONS, 2, 0, 1000),
    rangeSize: parseIntegerInRange(process.env.ROBINHOOD_RANGE_SIZE, 10, 1, 10_000),
    minRangeSize: parseIntegerInRange(process.env.ROBINHOOD_MIN_RANGE_SIZE, 1, 1, 1000),
    maxRangeSize: parseIntegerInRange(process.env.ROBINHOOD_MAX_RANGE_SIZE, 100, 1, 10_000),
    maxRangesPerPoll: robinhoodMaxRangesPerPoll,
    discoveryMaxRangesPerPoll: parseIntegerInRange(
      process.env.ROBINHOOD_DISCOVERY_MAX_RANGES_PER_POLL,
      robinhoodMaxRangesPerPoll,
      1,
      1000
    ),
    marketMaxRangesPerPoll: parseIntegerInRange(
      process.env.ROBINHOOD_MARKET_MAX_RANGES_PER_POLL,
      robinhoodMaxRangesPerPoll,
      1,
      1000
    ),
    maxAddressesPerLogRequest: parseIntegerInRange(
      process.env.ROBINHOOD_MAX_ADDRESSES_PER_LOG_REQUEST,
      100,
      1,
      1000
    ),
    marketLogFilterMode: String(process.env.ROBINHOOD_MARKET_LOG_FILTER_MODE || '')
      .trim().toLowerCase() === 'tracked-addresses'
      ? 'tracked-addresses'
      : 'topics-only',
    timestampConcurrency: parseIntegerInRange(
      process.env.ROBINHOOD_TIMESTAMP_CONCURRENCY,
      16,
      1,
      32
    ),
    timestampBatchSize: parseIntegerInRange(
      process.env.ROBINHOOD_TIMESTAMP_BATCH_SIZE,
      10,
      1,
      100
    ),
    observationConcurrency: parseIntegerInRange(
      process.env.ROBINHOOD_OBSERVATION_CONCURRENCY,
      1,
      1,
      16
    ),
  },

  robinhoodBackfillMarketScanner: {
    enabled: parseBoolean(process.env.ROBINHOOD_BACKFILL_SHADOW_ENABLED, false),
    startBlock: parseOptionalBlock(process.env.ROBINHOOD_BACKFILL_START_BLOCK),
    scanProvider: String(process.env.ROBINHOOD_SCAN_PROVIDER || 'drpc').trim().toLowerCase(),
    headProvider: String(process.env.ROBINHOOD_HEAD_PROVIDER || 'public').trim().toLowerCase(),
    publicRpcUrl: String(
      process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
    ).trim(),
    drpcRpcUrl: String(process.env.ROBINHOOD_DRPC_RPC_URL || '').trim(),
    alchemyRpcUrl: String(process.env.ROBINHOOD_ALCHEMY_RPC_URL || '').trim(),
    rangeSize: parseIntegerInRange(process.env.ROBINHOOD_SCAN_RANGE_SIZE, 10_000, 1, 10_000),
    minRangeSize: parseIntegerInRange(process.env.ROBINHOOD_SCAN_MIN_RANGE_SIZE, 10, 1, 10_000),
    inFlightRanges: parseIntegerInRange(process.env.ROBINHOOD_SCAN_IN_FLIGHT_RANGES, 1, 1, 8),
    maxLogsPerRange: parseIntegerInRange(
      process.env.ROBINHOOD_SCAN_MAX_LOGS_PER_RANGE, 10_000, 1, 1_000_000
    ),
    maxBufferedLogs: parseIntegerInRange(
      process.env.ROBINHOOD_SCAN_MAX_BUFFERED_LOGS, 50_000, 1, 1_000_000
    ),
    maxPendingLogs: parseIntegerInRange(
      process.env.ROBINHOOD_SCAN_MAX_PENDING_LOGS, 250_000, 1, 10_000_000
    ),
    confirmations: parseIntegerInRange(process.env.ROBINHOOD_CONFIRMATIONS, 2, 0, 1000),
    intervalMs: parseIntegerInRange(process.env.ROBINHOOD_SCAN_INTERVAL_MS, 2000, 250, 300_000),
    rpcTimeoutMs: parseIntegerInRange(
      process.env.ROBINHOOD_SCAN_RPC_TIMEOUT_MS, 15_000, 1000, 60_000
    ),
    rpcMaxRetries: parseIntegerInRange(process.env.ROBINHOOD_SCAN_RPC_MAX_RETRIES, 1, 0, 5),
    rpcMinIntervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_SCAN_RPC_MIN_INTERVAL_MS, 0, 0, 60_000
    ),
    decoderVersion: String(
      process.env.ROBINHOOD_BACKFILL_DECODER_VERSION || 'market-log-v1'
    ).trim(),
  },

  robinhoodBackfillDiscoveryScanner: {
    enabled: parseBoolean(process.env.ROBINHOOD_BACKFILL_DISCOVERY_ENABLED, false),
    scanProvider: String(
      process.env.ROBINHOOD_DISCOVERY_SCAN_PROVIDER || process.env.ROBINHOOD_SCAN_PROVIDER || 'drpc'
    ).trim().toLowerCase(),
    rangeSize: parseIntegerInRange(
      process.env.ROBINHOOD_DISCOVERY_SCAN_RANGE_SIZE, 10_000, 1, 10_000
    ),
    maxRangesPerPoll: parseIntegerInRange(
      process.env.ROBINHOOD_DISCOVERY_SCAN_MAX_RANGES_PER_POLL, 4, 1, 100
    ),
    decoderVersion: String(
      process.env.ROBINHOOD_BACKFILL_DISCOVERY_DECODER_VERSION || 'discovery-log-v1'
    ).trim(),
  },

  robinhoodBackfillEnrichmentWorker: {
    enabled: parseBoolean(process.env.ROBINHOOD_BACKFILL_ENRICHMENT_ENABLED, false),
    drpcRpcUrl: String(process.env.ROBINHOOD_DRPC_RPC_URL || '').trim(),
    alchemyRpcUrl: String(process.env.ROBINHOOD_ALCHEMY_RPC_URL || '').trim(),
    alchemyTimestampsEnabled: parseBoolean(
      process.env.ROBINHOOD_BACKFILL_ALCHEMY_TIMESTAMPS_ENABLED,
      false
    ),
    intervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_INTERVAL_MS, 2000, 250, 300_000
    ),
    maxErrorBackoffMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_MAX_ERROR_BACKOFF_MS,
      30_000,
      1000,
      300_000
    ),
    limit: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_CLAIM_SIZE, 100, 1, 1000
    ),
    leaseMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_LEASE_MS, 60_000, 1000, 86_400_000
    ),
    retryDelayMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_RETRY_DELAY_MS, 5000, 0, 604_800_000
    ),
    maxAttempts: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_MAX_ATTEMPTS, 5, 1, 100
    ),
    rpcBatchSize: parseIntegerInRange(process.env.ROBINHOOD_RPC_BATCH_SIZE, 100, 1, 100),
    rpcConcurrency: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_RPC_CONCURRENCY, 1, 1, 8
    ),
    prepareConcurrency: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_ENRICHMENT_PREPARE_CONCURRENCY, 16, 1, 64
    ),
    rpcTimeoutMs: parseIntegerInRange(
      process.env.ROBINHOOD_SCAN_RPC_TIMEOUT_MS, 15_000, 1000, 60_000
    ),
    rpcMaxRetries: parseIntegerInRange(process.env.ROBINHOOD_SCAN_RPC_MAX_RETRIES, 1, 0, 5),
    rpcMinIntervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_ENRICHMENT_RPC_MIN_INTERVAL_MS, 0, 0, 60_000
    ),
  },

  robinhoodBackfillFinalizerWorker: {
    enabled: parseBoolean(process.env.ROBINHOOD_BACKFILL_FINALIZER_ENABLED, false),
    intervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_FINALIZER_INTERVAL_MS, 2000, 250, 300_000
    ),
    maxErrorBackoffMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_FINALIZER_MAX_ERROR_BACKOFF_MS,
      30_000,
      1000,
      300_000
    ),
    limit: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_FINALIZER_RANGE_LIMIT, 100, 1, 1000
    ),
    statementTimeoutMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_FINALIZER_STATEMENT_TIMEOUT_MS,
      15_000,
      1000,
      300_000
    ),
    lockTimeoutMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_FINALIZER_LOCK_TIMEOUT_MS, 5000, 100, 60_000
    ),
  },

  robinhoodBackfillWatchdogWorker: {
    enabled: parseBoolean(
      process.env.ROBINHOOD_BACKFILL_WATCHDOG_ENABLED,
      parseBoolean(process.env.ROBINHOOD_BACKFILL_FINALIZER_ENABLED, false)
    ),
    intervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_WATCHDOG_INTERVAL_MS, 5000, 1000, 60_000
    ),
    maxErrorBackoffMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_WATCHDOG_MAX_ERROR_BACKOFF_MS,
      30_000,
      1000,
      300_000
    ),
    staleQueryThresholdMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_WATCHDOG_STALE_QUERY_MS, 20_000, 5000, 300_000
    ),
  },

  robinhoodBackfillAggregationWorker: {
    enabled: parseBoolean(process.env.ROBINHOOD_BACKFILL_AGGREGATION_ENABLED, false),
    intervalMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_AGGREGATION_INTERVAL_MS, 2000, 250, 300_000
    ),
    maxErrorBackoffMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_AGGREGATION_MAX_ERROR_BACKOFF_MS,
      30_000,
      1000,
      300_000
    ),
    claimLimit: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_AGGREGATION_CLAIM_SIZE, 10_000, 1, 100_000
    ),
    leaseMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_AGGREGATION_LEASE_MS, 900_000, 10_000, 86_400_000
    ),
    retryDelayMs: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_AGGREGATION_RETRY_DELAY_MS, 5000, 0, 604_800_000
    ),
    maxAttempts: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_AGGREGATION_MAX_ATTEMPTS, 5, 1, 100
    ),
    tokenLimit: parseIntegerInRange(
      process.env.ROBINHOOD_BACKFILL_AGGREGATION_TOKEN_LIMIT, 25, 1, 1000
    ),
  },

  robinhoodSignalDryRun: {
    enabled: parseBoolean(process.env.ROBINHOOD_SIGNAL_DRY_RUN_ENABLED, false),
    protocols: [...new Set(
      String(process.env.ROBINHOOD_SIGNAL_PROTOCOLS || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )],
    windowMs: parseOptionalNonNegativeInteger(
      process.env.ROBINHOOD_SIGNAL_WINDOW_MS,
      { positive: true }
    ),
    minLiquidityUsd: parseOptionalNonNegativeDecimal(
      process.env.ROBINHOOD_SIGNAL_MIN_LIQUIDITY_USD
    ),
    minVolumeUsd: parseOptionalNonNegativeDecimal(process.env.ROBINHOOD_SIGNAL_MIN_VOLUME_USD),
    minTransactions: parseOptionalNonNegativeInteger(
      process.env.ROBINHOOD_SIGNAL_MIN_TRANSACTIONS
    ),
    maxAgeMs: parseOptionalNonNegativeInteger(
      process.env.ROBINHOOD_SIGNAL_MAX_AGE_MS,
      { positive: true }
    ),
    candidateLimit: parseIntegerInRange(
      process.env.ROBINHOOD_SIGNAL_CANDIDATE_LIMIT,
      1000,
      1,
      5000
    ),
    sampleLimit: parseIntegerInRange(process.env.ROBINHOOD_SIGNAL_SAMPLE_LIMIT, 25, 1, 100),
    statementTimeoutMs: parseIntegerInRange(
      process.env.ROBINHOOD_SIGNAL_STATEMENT_TIMEOUT_MS,
      10_000,
      1000,
      60_000
    ),
  },

  robinhoodRollout,

  mockTrading: {
    enabled: parseBoolean(process.env.MOCK_TRADING_ENABLED, true),
  },

  solUsdPrice: {
    provider: (process.env.SOL_PRICE_PROVIDER || 'coinmarketcap').trim().toLowerCase(),
    apiKey: (process.env.COINMARKETCAP_API_KEY || '').trim(),
    assetId: (process.env.SOL_CMC_ASSET_ID || '5426').trim(),
    convert: (process.env.SOL_PRICE_CONVERT || 'USD').trim().toUpperCase(),
    pollIntervalMs: Math.max(30000, parseInt(process.env.SOL_PRICE_POLL_INTERVAL_MS || '264500', 10) || 264500),
    staleAfterMs: Math.max(30000, parseInt(process.env.SOL_PRICE_STALE_AFTER_MS || '300000', 10) || 300000),
    requestTimeoutMs: Math.max(1000, parseInt(process.env.SOL_PRICE_REQUEST_TIMEOUT_MS || '10000', 10) || 10000),
    minBackoffMs: Math.max(1000, parseInt(process.env.SOL_PRICE_MIN_BACKOFF_MS || '60000', 10) || 60000),
    maxBackoffMs: Math.max(1000, parseInt(process.env.SOL_PRICE_MAX_BACKOFF_MS || '1800000', 10) || 1800000),
  },

  gmgnDiscoveryWorker: {
    enabled: parseBoolean(process.env.GMGN_DISCOVERY_ENABLED, false),
    intervalMs: Math.max(250, parseInt(process.env.GMGN_DISCOVERY_INTERVAL_MS || process.env.GMGN_REQUEST_WINDOW_MS || '2000', 10) || 2000),
    apiKeyConfigured: Boolean(String(process.env.GMGN_API_KEY || '').trim()),
    schedulerOptions: {
      requestsPerWindow: Math.max(1, Math.min(parseInt(process.env.GMGN_REQUESTS_PER_WINDOW || '2', 10) || 2, 10)),
      requestWindowMs: Math.max(1000, parseInt(process.env.GMGN_REQUEST_WINDOW_MS || '2000', 10) || 2000),
      trendingLimit: Math.max(1, Math.min(parseInt(process.env.GMGN_TRENDING_LIMIT || '30', 10) || 30, 100)),
      backoffMinMs: Math.max(1000, parseInt(process.env.GMGN_BACKOFF_MIN_MS || '5000', 10) || 5000),
      backoffMaxMs: Math.max(1000, parseInt(process.env.GMGN_BACKOFF_MAX_MS || '60000', 10) || 60000),
    },
    ingestionOptions: {
      activeDexRecheckMs: Math.max(1000, parseInt(process.env.GMGN_ACTIVE_DEX_RECHECK_MS || '30000', 10) || 30000),
      alertEvaluationMinIntervalMs: Math.max(1000, parseInt(process.env.GMGN_ALERT_EVALUATION_MIN_INTERVAL_MS || '3000', 10) || 3000),
      staleAfterMs: Math.max(1000, parseInt(process.env.GMGN_PANEL_STALE_AFTER_MS || '15000', 10) || 15000),
      gmgnRiskLookupTokenLimitPerCycle: parseIntegerInRange(process.env.GMGN_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE, 5, 0, 100),
    },
    riskReviewQueueOptions: {
      intervalMs: Math.max(1000, parseInt(process.env.GMGN_RISK_REVIEW_QUEUE_INTERVAL_MS || '10000', 10) || 10000),
      tokenLimit: parseIntegerInRange(
        process.env.GMGN_RISK_REVIEW_QUEUE_TOKEN_LIMIT || process.env.GMGN_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE,
        5,
        0,
        100
      ),
      passedTtlMs: Math.max(60000, parseInt(process.env.GMGN_PRELIMINARY_REVIEW_TTL_MS || `${10 * 60 * 1000}`, 10) || (10 * 60 * 1000)),
    },
  },

  gmgnClaimSignalWorker: {
    enabled: parseBoolean(process.env.GMGN_CLAIM_SIGNAL_ENABLED, true),
    intervalMs: Math.max(5000, parseInt(process.env.GMGN_CLAIM_SIGNAL_INTERVAL_MS || '60000', 10) || 60000),
    apiKeyConfigured: Boolean(String(process.env.GMGN_API_KEY || '').trim()),
    chain: (process.env.GMGN_CLAIM_SIGNAL_CHAIN || process.env.GMGN_CHAIN || 'sol').trim().toLowerCase(),
    signalTypes: String(process.env.GMGN_CLAIM_SIGNAL_TYPES || '17,18')
      .split(',')
      .map((item) => parseInt(item.trim(), 10))
      .filter((item) => Number.isInteger(item)),
    maxAlertsPerToken: Math.max(1, parseInt(process.env.GMGN_CLAIM_SIGNAL_MAX_ALERTS_PER_TOKEN || '2', 10) || 2),
  },

  catalogWriteRateLimit: {
    windowMs: parseInt(process.env.CATALOG_WRITE_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.CATALOG_WRITE_RATE_LIMIT_MAX_REQUESTS || '60', 10),
  },

  catalogReadRateLimit: {
    windowMs: parseInt(process.env.CATALOG_READ_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.CATALOG_READ_RATE_LIMIT_MAX_REQUESTS || '120', 10),
  },

  xProfileRateLimit: {
    windowMs: parseInt(process.env.X_PROFILE_RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.X_PROFILE_RATE_LIMIT_MAX_REQUESTS || '120', 10),
  },

  xProfileCard: {
    baseUrl: process.env.X_PROFILE_BASE_URL || 'https://api.fxtwitter.com',
    ttlMs: parseIntegerInRange(process.env.X_PROFILE_CACHE_TTL_MS, 3600000, 60000, 86400000),
    negativeTtlMs: parseIntegerInRange(process.env.X_PROFILE_NEGATIVE_CACHE_TTL_MS, 21600000, 60000, 86400000),
    timeoutMs: parseIntegerInRange(process.env.X_PROFILE_TIMEOUT_MS, 6000, 1000, 30000),
    maxEntries: parseIntegerInRange(process.env.X_PROFILE_CACHE_MAX_ENTRIES, 2000, 50, 20000),
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
      maxHttpBufferSize: parseInt(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || '65536', 10),
      actionWindowMs: parseInt(process.env.SOCKET_ACTION_WINDOW_MS || '10000', 10),
      maxActionsPerWindow: parseInt(process.env.SOCKET_MAX_ACTIONS_PER_WINDOW || '180', 10),
    },
  },

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
