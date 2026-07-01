const tokenCatalog = require('../models/token-catalog');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const dexscreener = require('./dexscreener');
const gmgnClient = require('./gmgn-client');
const userAlertMatcher = require('./user-alert-matcher');
const { fillYoungTokenVolumeWindows } = require('./young-token-volume-fill');
const {
  isCumulativeVolumeWindowCoherent,
  normalizeVolume24hWithShorterWindows,
} = require('./volume-window-consistency');
const { extractDexSocialLinks } = require('../utils/dex-social-links');
const {
  AUTO_BLOCK_LABEL_PREFIXES,
  buildPrefixedAutoBlockLabel,
} = require('./auto-block-rule-labels');
const config = require('../../config');
const { isTraceDiscoveryEnabled, logTrace, shouldTraceAddress } = require('../utils/pump-migrate-trace');

const DEX_TOKENS_PER_REQUEST = 30;
const LOOP_INTERVAL_MS = config.catalogWorker.loopIntervalMs;
const MAX_TOKEN_BUDGET_PER_CYCLE = config.catalogWorker.tokenBudgetPerCycle;
const CONCURRENCY = config.catalogWorker.concurrency;
const DEX_BATCH_LIMIT = DEX_TOKENS_PER_REQUEST;
const DORMANT_RECHECK_MS = 30 * 60 * 1000;
const LOW_NEAR_RECHECK_MS = 15 * 1000;
const LOW_DUST_RECHECK_MS = 10 * 60 * 1000;
const LOW_ACTIVITY_24H_MAX_VOL = 5 * 1000;
const LOW_ACTIVITY_RECHECK_MS = 3 * 60 * 1000;
const LOW_ACTIVITY_JITTER_MS = 60 * 1000;
const NORMAL_RECHECK_MS = 4 * 1000;
const NORMAL_BOOST_6H_RECHECK_MS = 3 * 1000;
const NORMAL_BOOST_1H_RECHECK_MS = 3 * 1000;
const HIGH_HOT_RECHECK_MS = 2 * 1000;
const HIGH_WARM_RECHECK_MS = 3 * 1000;
const HIGH_VERY_LOW_VOL_RECHECK_MS = 5 * 1000;
const HIGH_LOW_VOL_RECHECK_MS = HIGH_WARM_RECHECK_MS;
const ERROR_RECHECK_MS = 60 * 1000;
const MANUAL_BOOTSTRAP_RECHECK_MS = 5 * 1000;
const RATE_LIMIT_HIGH_RECHECK_MS = 15 * 1000;
const RATE_LIMIT_NORMAL_RECHECK_MS = 2 * 60 * 1000;
const RATE_LIMIT_LOW_NEAR_RECHECK_MS = 3 * 60 * 1000;
const RATE_LIMIT_LOW_DUST_RECHECK_MS = 2 * 60 * 1000;
const RATE_LIMIT_MANUAL_RECHECK_MS = 15 * 1000;
const DEX_BATCH_DELAY_MS = 100;
const MANUAL_PRE_MIGRATION_GMGN_RECHECK_MS = 5 * 1000;
const MANUAL_GMGN_TOKEN_INFO_CONCURRENCY = 3;
const THROTTLE_LIST_LIMIT_MULTIPLIER = 8;
const THROTTLE_LIST_LIMIT_CAP = 2500;
const LOW_NEAR_JITTER_MS = 3 * 1000;
const LOW_DUST_JITTER_MS = 60 * 1000;
const DORMANT_JITTER_MS = 2 * 60 * 1000;
const MIGRATION_GRACE_FLOOR_MS = 10 * 60 * 1000;
const YOUNG_EXTREME_CHURN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const YOUNG_EXTREME_CHURN_MIN_INITIAL_MCAP = 20000;
const YOUNG_EXTREME_CHURN_MAX_MCAP = 100000;
const YOUNG_EXTREME_CHURN_MIN_VOL_5M = 100000;
const YOUNG_EXTREME_CHURN_MIN_VOL_MCAP_RATIO = 2.8;
const YOUNG_EXTREME_CHURN_CONFIRMATION_WINDOW_MS = 10 * 60 * 1000;
const YOUNG_EXTREME_CHURN_REQUIRED_HITS = 2;
const YOUNG_LOW_LIQUIDITY_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const YOUNG_LOW_LIQUIDITY_MAX_USD = 1000;
const YOUNG_LOW_LIQUIDITY_BLOCK_YEARS = 10;
const YOUNG_LOW_LIQUIDITY_EXEMPT_SUFFIXES = ['pump', 'bags', 'bonk'];
const GMGN_DEX_UNAVAILABLE_ZOMBIE_MIN_ERROR_COUNT = 30;
const GMGN_DEX_UNAVAILABLE_ZOMBIE_REASON = 'gmgn_dex_unavailable_zombie';
const GMGN_DEX_UNAVAILABLE_ZOMBIE_LOW_LIQUIDITY_USD = 1000;
const GMGN_DEX_UNAVAILABLE_ZOMBIE_BLOCK_YEARS = 10;

let timer = null;
let running = false;
let defaultGmgnClient = null;
const youngExtremeChurnState = new Map();
const manualGmgnTokenInfoInflight = new Map();
const manualGmgnTokenInfoQueue = [];
const liveManualAddressCache = new Map();
let manualGmgnTokenInfoActive = 0;
let status = {
  running: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastProcessed: 0,
  lastDueCount: 0,
  lastTotalDueCount: 0,
  lastBacklogCount: 0,
  lastRunDurationMs: 0,
  lastLoopOverrunMs: 0,
  lastScheduledDelayMs: LOOP_INTERVAL_MS,
  lastTokenBudget: MAX_TOKEN_BUDGET_PER_CYCLE,
  lastDexRequestBudget: Math.ceil(MAX_TOKEN_BUDGET_PER_CYCLE / DEX_TOKENS_PER_REQUEST),
  lastDexBatchCount: 0,
  lastProcessBatchCount: 0,
  lastRateLimitActive: false,
  lastRateLimitBackoffRemainingMs: 0,
  lastRateLimitFilteredCount: 0,
  lastThrottleMode: 'normal',
  lastRecoveryPhase: null,
  lastThrottleBatchDelayMs: DEX_BATCH_DELAY_MS,
  lastDueByPriority: { high: 0, normal: 0, low: 0, dormant: 0, other: 0 },
  lastBacklogByPriority: { high: 0, normal: 0, low: 0, dormant: 0, other: 0 },
  lastMaxOverdueMs: 0,
  lastMaxOverdueMsByPriority: { high: 0, normal: 0, low: 0, dormant: 0, other: 0 },
  totalProcessed: 0,
  totalEligible: 0,
  totalIneligible: 0,
  totalErrors: 0,
  lastYoungExtremeChurnAlertSuppressed: 0,
  lastYoungExtremeChurnAutoBlocked: 0,
  totalYoungExtremeChurnAlertSuppressed: 0,
  totalYoungExtremeChurnAutoBlocked: 0,
};

function emptyPriorityCounts() {
  return { high: 0, normal: 0, low: 0, dormant: 0, other: 0 };
}

function normalizePriorityBucket(priority) {
  const value = String(priority || '').trim().toLowerCase();
  if (value === 'high' || value === 'normal' || value === 'low' || value === 'dormant') {
    return value;
  }
  return 'other';
}

function summarizePriorityCounts(tokens) {
  const counts = emptyPriorityCounts();

  for (const token of Array.isArray(tokens) ? tokens : []) {
    counts[normalizePriorityBucket(token?.monitor_priority)] += 1;
  }

  return counts;
}

function subtractPriorityCounts(totalCounts = {}, processedCounts = {}) {
  const result = emptyPriorityCounts();

  for (const key of Object.keys(result)) {
    result[key] = Math.max(0, (Number(totalCounts[key]) || 0) - (Number(processedCounts[key]) || 0));
  }

  return result;
}

function normalizeDelayMs(value, fallback = LOOP_INTERVAL_MS) {
  const delayMs = Number(value);
  if (!Number.isFinite(delayMs)) {
    return fallback;
  }
  return Math.max(0, Math.round(delayMs));
}

function computeNextDelayMs(runDurationMs) {
  return normalizeDelayMs(LOOP_INTERVAL_MS - normalizeDelayMs(runDurationMs));
}

function addPriorityJitter(baseDelayMs, jitterMs, randomValue = Math.random()) {
  const safeBaseDelayMs = normalizeDelayMs(baseDelayMs, 0);
  const safeJitterMs = normalizeDelayMs(jitterMs, 0);
  if (safeJitterMs <= 0) {
    return safeBaseDelayMs;
  }

  const clampedRandom = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0;

  return safeBaseDelayMs + Math.round(clampedRandom * safeJitterMs);
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toVolumeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function toTimestampMs(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function getGraceUntilMs(value) {
  if (!value) return 0;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMigrationGraceActive(token, now = Date.now()) {
  if (!token) return false;
  return getGraceUntilMs(token.migration_grace_until) > now;
}

function isLowDustProtectedByMigrationGrace(token, marketCap, now = Date.now()) {
  return marketCap >= 0 && marketCap < 15000 && isMigrationGraceActive(token, now);
}

function isManualSource(token) {
  return String(token?.source || '').trim().toLowerCase() === 'user-manual';
}

function isGmgnManualState(token) {
  return String(token?.eligibility_state || '').trim().toLowerCase().startsWith('gmgn-');
}

function hasDexPairSnapshot(token) {
  const pairUrl = String(token?.last_pair_url || '').trim().toLowerCase();
  return Boolean(token?.last_pair_address)
    || pairUrl.includes('dexscreener.com');
}

function shouldCheckManualGmgnBeforeDex(token) {
  if (!isManualSource(token)) {
    return false;
  }

  const eligibilityState = String(token?.eligibility_state || '').trim().toLowerCase();
  const suppressedReason = String(token?.suppressed_reason || '').trim().toLowerCase();
  const marketCap = Number(token?.last_mcap || 0);

  return eligibilityState === 'pending'
    || isGmgnManualState(token)
    || eligibilityState === 'dex-missing'
    || eligibilityState === 'dex-unavailable'
    || suppressedReason === 'dex_pair_missing'
    || suppressedReason === 'dex_unavailable'
    || (!hasDexPairSnapshot(token) && hasKnownLaunchAddressSuffix(token) && marketCap < 30000);
}

const LAUNCH_ADDRESS_SUFFIXES = ['pump', 'bonk', 'brrr', 'bags'];

function hasKnownLaunchAddressSuffix(token) {
  const address = String(token?.address || '').trim().toLowerCase();
  return LAUNCH_ADDRESS_SUFFIXES.some((suffix) => address.endsWith(suffix));
}

function hasYoungLowLiquidityExemptSuffix(token) {
  const address = String(token?.address || '').trim().toLowerCase();
  return YOUNG_LOW_LIQUIDITY_EXEMPT_SUFFIXES.some((suffix) => address.endsWith(suffix));
}

function isGmgnDexUnavailableZombie(token) {
  if (!token || isManualSource(token) || hasKnownLaunchAddressSuffix(token)) {
    return false;
  }

  const source = String(token.source || '').trim().toLowerCase();
  if (source === 'admin-blocked') {
    return false;
  }

  const errorCount = Number(token.evaluation_error_count || 0);
  if (errorCount < GMGN_DEX_UNAVAILABLE_ZOMBIE_MIN_ERROR_COUNT) {
    return false;
  }

  const previousSuppression = String(token.suppressed_reason || '').trim().toLowerCase();
  const previousError = String(token.last_evaluation_error || '').trim().toLowerCase();
  if (previousSuppression !== 'dex_unavailable' && previousError !== 'dex_unavailable') {
    return false;
  }

  const vol5m = Number(token.last_vol_5m || 0);
  if (vol5m > 0) {
    return false;
  }

  return true;
}

function isPumpLikeToken(token, pair) {
  const source = String(token?.source || '').trim().toLowerCase();
  const dexId = String(pair?.dexId || '').trim().toLowerCase();
  return source.includes('pump') || dexId.includes('pump');
}

function resolveInitialMcap(initialBucket, snapshot) {
  const candidates = [
    initialBucket?.openMcap,
    initialBucket?.closeMcap,
    initialBucket?.mcap,
    snapshot?.marketCap,
  ];

  for (const candidate of candidates) {
    const value = toNumber(candidate);
    if (value != null && value > 0) {
      return value;
    }
  }

  return null;
}

function buildYoungExtremeChurnLabel(assessment) {
  return buildPrefixedAutoBlockLabel(AUTO_BLOCK_LABEL_PREFIXES.CATALOG_YOUNG_EXTREME_CHURN, [
    Math.round(assessment.currentMcap),
    Math.round(assessment.initialMcap),
    Math.round(assessment.vol5m),
    `${Math.round(assessment.volMcapRatio * 10) / 10}x`,
  ]);
}

function getDefaultGmgnClient() {
  if (!defaultGmgnClient) {
    defaultGmgnClient = gmgnClient.createGmgnClient();
  }
  return defaultGmgnClient;
}

function setDefaultGmgnClientForTest(client) {
  defaultGmgnClient = client || null;
}

function buildGmgnDexUnavailableLowLiquidityLabel(snapshot = {}) {
  const liquidityUsd = Math.round(toNumber(snapshot.liquidityUsd) || 0);
  const marketCap = Math.round(toNumber(snapshot.mcap) || 0);
  return buildPrefixedAutoBlockLabel(
    AUTO_BLOCK_LABEL_PREFIXES.GMGN_LIQUIDITY_UNDER_1K_SPAM,
    [liquidityUsd, marketCap]
  );
}

function buildYoungLowLiquidityLabel(assessment = {}) {
  const liquidityUsd = Math.round(toNumber(assessment.liquidityUsd) || 0);
  const marketCap = Math.round(toNumber(assessment.marketCap) || 0);
  return buildPrefixedAutoBlockLabel(
    AUTO_BLOCK_LABEL_PREFIXES.CATALOG_LIQUIDITY_UNDER_1K_48H,
    [liquidityUsd, marketCap]
  );
}

function readNestedNumber(source, containerKey, valueKey) {
  return toNumber(source?.[containerKey]?.[valueKey]);
}

function resolveSnapshotVolume(snapshot, pair, snapshotKey, pairKey) {
  const snapshotValue = toNumber(snapshot?.[snapshotKey]);
  return snapshotValue == null ? readNestedNumber(pair, 'volume', pairKey) : snapshotValue;
}

function firstPresentValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') {
      return value;
    }
  }
  return null;
}

function buildYoungExtremeChurnCatalogSnapshot(token, updatedToken, pair) {
  return {
    source: firstPresentValue(token?.source),
    address: firstPresentValue(token?.address),
    symbol: firstPresentValue(updatedToken?.symbol, pair?.baseToken?.symbol, token?.symbol),
    name: firstPresentValue(updatedToken?.name, pair?.baseToken?.name, token?.name),
    eligibilityState: firstPresentValue(token?.eligibility_state),
    monitorPriority: firstPresentValue(token?.monitor_priority),
  };
}

function buildYoungExtremeChurnMarketSnapshot(token, pair, snapshot, assessment) {
  return {
    currentMcap: assessment.currentMcap,
    initialMcap: assessment.initialMcap,
    vol5m: assessment.vol5m,
    volMcapRatio: assessment.volMcapRatio,
    marketCap: toNumber(snapshot?.marketCap),
    price: toNumber(snapshot?.priceUsd),
    pairAddress: pair?.pairAddress || null,
    pairCreatedAt: pair?.pairCreatedAt || token?.last_token_created_at_ms || null,
    liquidityUsd: readNestedNumber(pair, 'liquidity', 'usd'),
    vol1h: resolveSnapshotVolume(snapshot, pair, 'vol1h', 'h1'),
    vol6h: resolveSnapshotVolume(snapshot, pair, 'vol6h', 'h6'),
    vol24h: resolveSnapshotVolume(snapshot, pair, 'vol24h', 'h24'),
  };
}

function buildYoungExtremeChurnBlockEvidence(token, updatedToken, pair, snapshot, assessment) {
  const label = buildYoungExtremeChurnLabel(assessment);
  return {
    pipeline: 'catalog-worker:young-extreme-churn',
    source: token?.source || null,
    catalogSnapshot: buildYoungExtremeChurnCatalogSnapshot(token, updatedToken, pair),
    marketSnapshot: buildYoungExtremeChurnMarketSnapshot(token, pair, snapshot, assessment),
    assessment,
    ruleMatches: [{ label, reason: assessment.reason || 'young-extreme-churn' }],
    gmgnSnapshot: {},
  };
}

function buildYoungLowLiquidityCatalogSnapshot(token, updatedToken, pair) {
  return {
    source: firstPresentValue(token?.source),
    address: firstPresentValue(token?.address),
    symbol: firstPresentValue(updatedToken?.symbol, pair?.baseToken?.symbol, token?.symbol),
    name: firstPresentValue(updatedToken?.name, pair?.baseToken?.name, token?.name),
    eligibilityState: firstPresentValue(token?.eligibility_state),
    monitorPriority: firstPresentValue(token?.monitor_priority),
    riskReviewLabel: firstPresentValue(token?.risk_review_label),
    riskReviewSource: firstPresentValue(token?.risk_review_source),
  };
}

function buildYoungLowLiquidityMarketSnapshot(token, pair, snapshot, assessment) {
  return {
    mcap: assessment.marketCap,
    price: toNumber(pair?.priceUsd),
    pairAddress: pair?.pairAddress || null,
    pairCreatedAt: pair?.pairCreatedAt || token?.last_token_created_at_ms || null,
    liquidityUsd: assessment.liquidityUsd,
    vol5m: toNumber(snapshot?.vol5m),
    vol1h: toNumber(snapshot?.vol1h),
    vol6h: toNumber(snapshot?.vol6h),
    vol24h: toNumber(snapshot?.vol24h),
  };
}

function buildYoungLowLiquidityBlockEvidence(token, updatedToken, pair, snapshot, assessment) {
  const label = buildYoungLowLiquidityLabel(assessment);
  return {
    pipeline: 'catalog-worker:young-low-liquidity',
    source: token?.source || null,
    catalogSnapshot: buildYoungLowLiquidityCatalogSnapshot(token, updatedToken, pair),
    marketSnapshot: buildYoungLowLiquidityMarketSnapshot(token, pair, snapshot, assessment),
    assessment,
    ruleMatches: [{ label, reason: assessment.reason || 'young-low-liquidity' }],
    gmgnSnapshot: {},
  };
}

function buildGmgnDexUnavailableLowLiquidityEvidence(token, gmgnInfo, snapshot, label) {
  return {
    pipeline: 'catalog-worker:gmgn-dex-unavailable-low-liquidity',
    source: 'gmgn',
    catalogSnapshot: {
      source: firstPresentValue(token?.source),
      address: firstPresentValue(token?.address),
      symbol: firstPresentValue(gmgnInfo?.symbol, token?.symbol),
      name: firstPresentValue(gmgnInfo?.name, token?.name),
      eligibilityState: firstPresentValue(token?.eligibility_state),
      suppressedReason: firstPresentValue(token?.suppressed_reason),
      monitorPriority: firstPresentValue(token?.monitor_priority),
      evaluationErrorCount: Number(token?.evaluation_error_count || 0),
    },
    marketSnapshot: snapshot,
    gmgnSnapshot: {
      info: gmgnInfo || null,
    },
    assessment: {
      reason: GMGN_DEX_UNAVAILABLE_ZOMBIE_REASON,
      liquidityUsd: snapshot.liquidityUsd,
      thresholdUsd: GMGN_DEX_UNAVAILABLE_ZOMBIE_LOW_LIQUIDITY_USD,
    },
    ruleMatches: [{ label, pipeline: 'catalog-worker:gmgn-dex-unavailable-low-liquidity' }],
  };
}

function buildGmgnDexUnavailableMarketSnapshot(token, gmgnInfo) {
  return {
    mcap: toNumber(gmgnInfo?.marketCap) ?? toNumber(token?.last_mcap),
    price: toNumber(gmgnInfo?.price) ?? toNumber(token?.last_price),
    liquidityUsd: toNumber(gmgnInfo?.liquidityUsd),
    vol5m: toNumber(token?.last_vol_5m),
    vol1h: toNumber(token?.last_vol_1h),
    vol6h: toNumber(token?.last_vol_6h),
    vol24h: toNumber(token?.last_vol_24h),
    tokenCreatedAt: gmgnInfo?.tokenCreatedAt || token?.last_token_created_at_ms || null,
  };
}

function resolveGmgnManualPreMigrationPriority(marketCap) {
  if (marketCap >= 100000) return 'high';
  if (marketCap >= 30000) return 'normal';
  return 'low';
}

function resolveGmgnManualPreMigrationState(marketCap) {
  if (marketCap >= 100000) return 'gmgn-high';
  if (marketCap >= 30000) return 'gmgn-normal';
  return 'gmgn-low';
}

function hasManualPreMigrationGmgnMarketData(marketCap, price) {
  return marketCap > 0 || price > 0;
}

function buildManualPreMigrationGmgnVolumes(gmgnInfo, now) {
  return fillYoungTokenVolumeWindows({
    tokenCreatedAt: gmgnInfo?.tokenCreatedAt,
    vol1m: toNumber(gmgnInfo?.vol1m),
    vol5m: toNumber(gmgnInfo?.vol5m),
    vol1h: toNumber(gmgnInfo?.vol1h),
    vol6h: toNumber(gmgnInfo?.vol6h),
    vol24h: toNumber(gmgnInfo?.vol24h),
  }, { now });
}

function buildManualPreMigrationGmgnMetadata(token, gmgnInfo) {
  return {
    symbol: firstPresentValue(gmgnInfo?.symbol, token?.symbol),
    name: firstPresentValue(gmgnInfo?.name, token?.name),
    pairAddress: firstPresentValue(gmgnInfo?.pairAddress),
    pairUrl: firstPresentValue(gmgnInfo?.pairUrl),
    imageUrl: firstPresentValue(gmgnInfo?.imageUrl),
    tokenCreatedAt: firstPresentValue(gmgnInfo?.tokenCreatedAt, token?.last_token_created_at_ms),
  };
}

function buildManualPreMigrationGmgnPriceChanges(gmgnInfo) {
  return {
    priceChange1h: toNumber(gmgnInfo?.priceChange1h),
    priceChange6h: toNumber(gmgnInfo?.priceChange6h),
    priceChange24h: toNumber(gmgnInfo?.priceChange24h),
  };
}

function hasGmgnLaunchpadSignal(gmgnInfo = {}) {
  if (!gmgnInfo || typeof gmgnInfo !== 'object') {
    return false;
  }
  return Boolean(
    gmgnInfo.launchpad
    || gmgnInfo.launchpadPlatform
    || gmgnInfo.launchpadStatus != null
    || gmgnInfo.launchpadProgress != null
  );
}

function hasGmgnMigrationSignal(gmgnInfo = {}) {
  if (!gmgnInfo || typeof gmgnInfo !== 'object') {
    return false;
  }
  return Boolean(
    gmgnInfo.openTimestamp
    || gmgnInfo.migratedTimestamp
    || gmgnInfo.migratedPool
  );
}

function shouldUseGmgnPreMigrationInfo(gmgnInfo = {}) {
  return hasGmgnLaunchpadSignal(gmgnInfo)
    && !hasGmgnMigrationSignal(gmgnInfo);
}

function shouldUseGmgnManualFallbackInfo(gmgnInfo = {}) {
  return hasGmgnLaunchpadSignal(gmgnInfo);
}

function buildManualPreMigrationGmgnSnapshot(token, gmgnInfo, now = new Date()) {
  const marketCap = toNumber(gmgnInfo?.marketCap);
  const price = toNumber(gmgnInfo?.price);
  if (!hasManualPreMigrationGmgnMarketData(marketCap, price)) {
    return null;
  }

  const filledVolumes = buildManualPreMigrationGmgnVolumes(gmgnInfo, now);
  const metadata = buildManualPreMigrationGmgnMetadata(token, gmgnInfo);
  const priceChanges = buildManualPreMigrationGmgnPriceChanges(gmgnInfo);

  return {
    address: token.address,
    ...metadata,
    mcap: marketCap,
    price,
    vol1m: filledVolumes.vol1m,
    vol5m: filledVolumes.vol5m,
    vol1h: filledVolumes.vol1h,
    vol6h: filledVolumes.vol6h,
    vol24h: filledVolumes.vol24h,
    ...priceChanges,
    liquidityUsd: toNumber(gmgnInfo?.liquidityUsd),
  };
}

function runManualGmgnTokenInfoTask(task) {
  return new Promise((resolve, reject) => {
    manualGmgnTokenInfoQueue.push({ task, resolve, reject });
    drainManualGmgnTokenInfoQueue();
  });
}

function drainManualGmgnTokenInfoQueue() {
  while (
    manualGmgnTokenInfoActive < MANUAL_GMGN_TOKEN_INFO_CONCURRENCY
    && manualGmgnTokenInfoQueue.length > 0
  ) {
    const next = manualGmgnTokenInfoQueue.shift();
    manualGmgnTokenInfoActive += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        manualGmgnTokenInfoActive = Math.max(0, manualGmgnTokenInfoActive - 1);
        drainManualGmgnTokenInfoQueue();
      });
  }
}

async function hasLiveManualAddressForGmgn(address) {
  const normalized = String(address || '').trim();
  if (!normalized) {
    return false;
  }

  const cached = liveManualAddressCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await tokenCatalog.hasUserManualAddress(normalized);
  liveManualAddressCache.set(normalized, {
    value,
    expiresAt: Date.now() + 30 * 1000,
  });
  if (!value && typeof tokenCatalog.demoteFormerManualAddress === 'function') {
    await tokenCatalog.demoteFormerManualAddress(normalized);
  }
  return value;
}

async function fetchManualGmgnTokenInfo(token) {
  if (!isManualSource(token)) {
    return null;
  }

  const address = String(token?.address || '').trim();
  if (!await hasLiveManualAddressForGmgn(address)) {
    return null;
  }

  const chain = token?.chain || 'solana';
  const cacheKey = `${String(chain).trim().toLowerCase()}:${address}`;
  const inflight = manualGmgnTokenInfoInflight.get(cacheKey);
  if (inflight) {
    try {
      return await inflight;
    } catch (error) {
      console.warn(`[CatalogWorker] Failed to fetch GMGN info for manual token ${token.address}: ${error.message}`);
      return null;
    }
  }

  const request = runManualGmgnTokenInfoTask(() => getDefaultGmgnClient().fetchTokenInfo({
    chain,
    address,
    skipCache: true,
  })).finally(() => {
    manualGmgnTokenInfoInflight.delete(cacheKey);
  });
  manualGmgnTokenInfoInflight.set(cacheKey, request);

  try {
    return await request;
  } catch (error) {
    console.warn(`[CatalogWorker] Failed to fetch GMGN info for manual token ${token.address}: ${error.message}`);
    return null;
  }
}

async function applyManualGmgnInfoSnapshot(token, gmgnInfo, traceInitialEval, resultLabel) {
  const snapshot = buildManualPreMigrationGmgnSnapshot(token, gmgnInfo, new Date());
  if (!snapshot) {
    return null;
  }

  const nextEvaluationAt = new Date(Date.now() + MANUAL_PRE_MIGRATION_GMGN_RECHECK_MS);

  const marketCap = snapshot.mcap || 0;
  const updatedToken = await tokenCatalog.applyEvaluationResult(token.address, {
    evaluationSource: 'gmgn',
    eligibilityState: resolveGmgnManualPreMigrationState(marketCap),
    eligibleForMonitoring: marketCap > 0,
    suppressedReason: marketCap > 0 ? null : 'mcap_unavailable',
    monitorPriority: resolveGmgnManualPreMigrationPriority(marketCap),
    nextEvaluationAt,
    lastEvaluationError: null,
    evaluationErrorCount: 0,
    symbol: snapshot.symbol,
    name: snapshot.name,
    pairAddress: snapshot.pairAddress,
    pairUrl: snapshot.pairUrl,
    imageUrl: snapshot.imageUrl,
    mcap: snapshot.mcap,
    price: snapshot.price,
    vol5m: snapshot.vol5m,
    vol1h: snapshot.vol1h,
    vol6h: snapshot.vol6h,
    vol24h: snapshot.vol24h,
    priceChange1h: snapshot.priceChange1h,
    priceChange6h: snapshot.priceChange6h,
    priceChange24h: snapshot.priceChange24h,
    liquidityUsd: snapshot.liquidityUsd,
    tokenCreatedAt: toTimestampMs(snapshot.tokenCreatedAt),
  });

  await tokenMarketBucket1m.upsertSnapshotBucket({
    tokenAddress: token.address,
    pairAddress: snapshot.pairAddress,
    mcap: snapshot.mcap,
    price: snapshot.price,
    source: 'gmgn',
  });
  await tokenMarketVolumeBucket1m.upsertSnapshotBucket({
    tokenAddress: token.address,
    vol1m: snapshot.vol1m,
    vol5m: snapshot.vol5m,
    vol1h: snapshot.vol1h,
    vol6h: snapshot.vol6h,
    vol24h: snapshot.vol24h,
    source: 'gmgn',
  });

  if (traceInitialEval) {
    logTrace('catalog_eval_result', {
      tokenAddress: token.address,
      source: token.source || null,
      result: resultLabel,
      marketCap,
      nextEvaluationAt: nextEvaluationAt.toISOString(),
    });
  }

  status.totalEligible += marketCap > 0 ? 1 : 0;
  status.totalIneligible += marketCap > 0 ? 0 : 1;
  return updatedToken;
}

async function evaluateManualPreMigrationWithGmgn(token, gmgnInfo, traceInitialEval) {
  if (!shouldUseGmgnPreMigrationInfo(gmgnInfo)) {
    return null;
  }
  return applyManualGmgnInfoSnapshot(
    token,
    gmgnInfo,
    traceInitialEval,
    'gmgn-manual-launchpad-pre-migration'
  );
}

async function evaluateManualGmgnFallback(token, gmgnInfo, traceInitialEval, dexResult) {
  if (!shouldUseGmgnManualFallbackInfo(gmgnInfo)) {
    return null;
  }
  return applyManualGmgnInfoSnapshot(
    token,
    gmgnInfo,
    traceInitialEval,
    `gmgn-manual-fallback-${dexResult}`
  );
}

async function evaluateDexUnavailableWithManualFallback(token, gmgnInfo, traceInitialEval) {
  const gmgnFallbackToken = await evaluateManualGmgnFallback(token, gmgnInfo, traceInitialEval, 'dex-unavailable');
  return gmgnFallbackToken || evaluateDexUnavailableToken(token, traceInitialEval);
}

function getYoungExtremeChurnState(address, nowMs = Date.now()) {
  const key = String(address || '').trim();
  if (!key) {
    return null;
  }

  const state = youngExtremeChurnState.get(key);
  if (!state) {
    return null;
  }

  if (nowMs - state.firstSeenAtMs > YOUNG_EXTREME_CHURN_CONFIRMATION_WINDOW_MS) {
    youngExtremeChurnState.delete(key);
    return null;
  }

  return state;
}

function recordYoungExtremeChurnSuspicion(address, assessment, nowMs = Date.now()) {
  const key = String(address || '').trim();
  if (!key) {
    return { hitCount: 0, confirmed: false };
  }

  const previous = getYoungExtremeChurnState(key, nowMs);
  const state = {
    firstSeenAtMs: previous?.firstSeenAtMs || nowMs,
    lastSeenAtMs: nowMs,
    hitCount: (previous?.hitCount || 0) + 1,
    assessment,
  };
  youngExtremeChurnState.set(key, state);

  return {
    ...state,
    confirmed: state.hitCount >= YOUNG_EXTREME_CHURN_REQUIRED_HITS,
  };
}

function clearYoungExtremeChurnState(address) {
  youngExtremeChurnState.delete(String(address || '').trim());
}

function resolveYoungExtremeChurnAgeMs(token, pair, now) {
  const createdAtMs = toTimestampMs(pair?.pairCreatedAt || token?.last_token_created_at_ms);
  if (!createdAtMs || now - createdAtMs > YOUNG_EXTREME_CHURN_MAX_AGE_MS) {
    return null;
  }

  return now - createdAtMs;
}

function passesYoungExtremeChurnMarketShape({ currentMcap, initialMcap, vol5m, volMcapRatio }) {
  return currentMcap <= YOUNG_EXTREME_CHURN_MAX_MCAP
    && initialMcap >= YOUNG_EXTREME_CHURN_MIN_INITIAL_MCAP
    && initialMcap <= YOUNG_EXTREME_CHURN_MAX_MCAP
    && vol5m >= YOUNG_EXTREME_CHURN_MIN_VOL_5M
    && volMcapRatio >= YOUNG_EXTREME_CHURN_MIN_VOL_MCAP_RATIO;
}

function assessYoungExtremeChurn(token, pair, snapshot, initialBucket, now = Date.now()) {
  if (isManualSource(token) || isPumpLikeToken(token, pair)) {
    return { shouldBlock: false, reason: 'trusted-source' };
  }

  const ageMs = resolveYoungExtremeChurnAgeMs(token, pair, now);
  if (ageMs == null) {
    return { shouldBlock: false, reason: 'age' };
  }

  const currentMcap = toNumber(snapshot?.marketCap);
  const vol5m = toNumber(snapshot?.vol5m);
  const initialMcap = resolveInitialMcap(initialBucket, snapshot);
  if (currentMcap == null || vol5m == null || initialMcap == null) {
    return { shouldBlock: false, reason: 'missing-market-data' };
  }

  const volMcapRatio = currentMcap > 0 ? vol5m / currentMcap : 0;
  const shouldBlock = passesYoungExtremeChurnMarketShape({
    currentMcap,
    initialMcap,
    vol5m,
    volMcapRatio,
  });

  return {
    shouldBlock,
    reason: shouldBlock ? 'young-extreme-churn' : 'thresholds',
    currentMcap,
    initialMcap,
    vol5m,
    volMcapRatio,
    ageMs,
  };
}

async function assessYoungExtremeChurnWithInitialBucket(token, pair, snapshot) {
  const preliminaryAssessment = assessYoungExtremeChurn(token, pair, snapshot, null);
  if (!preliminaryAssessment.shouldBlock) {
    clearYoungExtremeChurnState(token.address);
    return preliminaryAssessment;
  }

  const initialBucket = await tokenMarketBucket1m.getInitialBucketByAddress(token.address);
  const assessment = assessYoungExtremeChurn(token, pair, snapshot, initialBucket);
  if (!assessment.shouldBlock) {
    clearYoungExtremeChurnState(token.address);
  }

  return assessment;
}

async function applyYoungExtremeChurnBlock(token, updatedToken, pair, assessment, snapshot = {}) {
  const confirmation = recordYoungExtremeChurnSuspicion(token.address, assessment);
  if (!confirmation.confirmed) {
    status.lastYoungExtremeChurnAlertSuppressed += 1;
    status.totalYoungExtremeChurnAlertSuppressed += 1;
    return {
      blocked: false,
      suppressAlert: true,
      assessment,
      confirmation,
    };
  }

  await adminBlockedToken.add({
    address: token.address,
    label: buildYoungExtremeChurnLabel(assessment),
    createdBy: null,
    evidence: buildYoungExtremeChurnBlockEvidence(token, updatedToken, pair, snapshot, assessment),
  });

  const blockedToken = await tokenCatalog.applyEvaluationResult(token.address, {
    eligibilityState: 'admin-blocked',
    eligibleForMonitoring: false,
    suppressedReason: 'admin_blocked',
    monitorPriority: 'dormant',
    nextEvaluationAt: new Date(Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)),
    lastEvaluationError: null,
    evaluationErrorCount: 0,
    symbol: updatedToken?.symbol || pair?.baseToken?.symbol || token?.symbol || null,
    name: updatedToken?.name || pair?.baseToken?.name || token?.name || null,
  });

  status.lastYoungExtremeChurnAutoBlocked += 1;
  status.totalYoungExtremeChurnAutoBlocked += 1;
  clearYoungExtremeChurnState(token.address);

  return {
    blocked: true,
    blockedToken: blockedToken || updatedToken,
    assessment,
  };
}

async function autoBlockYoungExtremeChurn(token, updatedToken, pair, snapshot) {
  const assessment = await assessYoungExtremeChurnWithInitialBucket(token, pair, snapshot);
  if (!assessment.shouldBlock) {
    return { blocked: false, assessment };
  }

  return applyYoungExtremeChurnBlock(token, updatedToken, pair, assessment, snapshot);
}

function getYoungLowLiquiditySkipReason(token) {
  if (!token || isManualSource(token)) {
    return 'trusted-source';
  }
  if (hasYoungLowLiquidityExemptSuffix(token)) {
    return 'launch-suffix';
  }
  return null;
}

function resolveYoungLowLiquidityAgeMs(token, pair, now = Date.now()) {
  const createdAtMs = toTimestampMs(pair?.pairCreatedAt || token?.last_token_created_at_ms);
  if (!createdAtMs) {
    return null;
  }

  const ageMs = now - createdAtMs;
  if (ageMs < 0 || ageMs >= YOUNG_LOW_LIQUIDITY_MAX_AGE_MS) {
    return null;
  }
  return ageMs;
}

function assessYoungLowLiquidity(token, pair, snapshot, now = Date.now()) {
  const skipReason = getYoungLowLiquiditySkipReason(token);
  if (skipReason) {
    return { shouldBlock: false, reason: skipReason };
  }

  const ageMs = resolveYoungLowLiquidityAgeMs(token, pair, now);
  if (ageMs == null) {
    return { shouldBlock: false, reason: 'age' };
  }
  const liquidityUsd = toNumber(snapshot?.liquidityUsd ?? pair?.liquidity?.usd);
  if (liquidityUsd == null || liquidityUsd > YOUNG_LOW_LIQUIDITY_MAX_USD) {
    return { shouldBlock: false, reason: 'liquidity', liquidityUsd, ageMs };
  }

  const marketCap = toNumber(snapshot?.marketCap ?? pair?.marketCap ?? pair?.fdv ?? token?.last_mcap);
  return {
    shouldBlock: true,
    reason: 'young-low-liquidity',
    ageMs,
    liquidityUsd,
    marketCap,
    thresholdUsd: YOUNG_LOW_LIQUIDITY_MAX_USD,
    maxAgeMs: YOUNG_LOW_LIQUIDITY_MAX_AGE_MS,
  };
}

function buildBlockEvaluationPayload(token, updatedToken, pair) {
  return {
    eligibilityState: 'admin-blocked',
    eligibleForMonitoring: false,
    suppressedReason: 'admin_blocked',
    monitorPriority: 'dormant',
    nextEvaluationAt: new Date(Date.now() + (YOUNG_LOW_LIQUIDITY_BLOCK_YEARS * 365 * 24 * 60 * 60 * 1000)),
    lastEvaluationError: null,
    evaluationErrorCount: 0,
    symbol: updatedToken?.symbol || pair?.baseToken?.symbol || token?.symbol || null,
    name: updatedToken?.name || pair?.baseToken?.name || token?.name || null,
  };
}

async function autoBlockYoungLowLiquidity(token, updatedToken, pair, snapshot) {
  const assessment = assessYoungLowLiquidity(token, pair, snapshot);
  if (!assessment.shouldBlock) {
    return { blocked: false, assessment };
  }

  const label = buildYoungLowLiquidityLabel(assessment);
  await adminBlockedToken.add({
    address: token.address,
    label,
    createdBy: null,
    allowAutoValidOverride: true,
    evidence: buildYoungLowLiquidityBlockEvidence(token, updatedToken, pair, snapshot, assessment),
  });

  const blockedToken = await tokenCatalog.applyEvaluationResult(
    token.address,
    buildBlockEvaluationPayload(token, updatedToken, pair)
  );

  return {
    blocked: true,
    blockedToken: blockedToken || updatedToken,
    assessment,
  };
}

async function handlePostBucketAutoBlocks(token, updatedToken, bestPair, snapshot) {
  const youngLowLiquidityBlock = await autoBlockYoungLowLiquidity(token, updatedToken, bestPair, snapshot);
  if (youngLowLiquidityBlock.blocked) {
    console.warn(
      `[CatalogWorker] Auto-blocked ${token.address} for young low liquidity: ${buildYoungLowLiquidityLabel(youngLowLiquidityBlock.assessment)}`
    );
    return youngLowLiquidityBlock.blockedToken;
  }

  const youngExtremeChurnBlock = await autoBlockYoungExtremeChurn(token, updatedToken, bestPair, snapshot);
  if (youngExtremeChurnBlock.blocked) {
    console.warn(
      `[CatalogWorker] Auto-blocked ${token.address} before alert matcher: ${buildYoungExtremeChurnLabel(youngExtremeChurnBlock.assessment)}`
    );
    return youngExtremeChurnBlock.blockedToken;
  }
  if (youngExtremeChurnBlock.suppressAlert) {
    console.warn(
      `[CatalogWorker] Suppressed alert for young extreme churn candidate ${token.address}: ${buildYoungExtremeChurnLabel(youngExtremeChurnBlock.assessment)}`
    );
    return updatedToken;
  }
  return null;
}

function isLowActivityAutoToken(token, vol24h, volumeWindows = {}) {
  const numericVol24h = Number(vol24h);
  const vol1h = volumeWindows.vol1h ?? token?.last_vol_1h;
  const vol6h = volumeWindows.vol6h ?? token?.last_vol_6h;
  return !isManualSource(token)
    && Number.isFinite(numericVol24h)
    && numericVol24h >= 0
    && numericVol24h < LOW_ACTIVITY_24H_MAX_VOL
    && isCumulativeVolumeWindowCoherent({ vol1h, vol6h, vol24h: numericVol24h });
}

function getLowActivityMinimumRecheckMs(token, vol24h, volumeWindows = {}) {
  return isLowActivityAutoToken(token, vol24h, volumeWindows) ? LOW_ACTIVITY_RECHECK_MS : 0;
}

function buildPriorityVolumeWindows(bestPair, token, now) {
  return normalizeVolume24hWithShorterWindows(fillYoungTokenVolumeWindows({
    tokenCreatedAt: bestPair?.pairCreatedAt,
    vol5m: toVolumeNumber(bestPair?.volume?.m5),
    vol1h: toVolumeNumber(bestPair?.volume?.h1),
    vol6h: toVolumeNumber(bestPair?.volume?.h6),
    vol24h: toVolumeNumber(bestPair?.volume?.h24),
  }, { now: new Date(now) }), {
    vol6h: token?.last_vol_6h,
    vol24h: token?.last_vol_24h,
  });
}

function derivePrioritySnapshot(bestPair, token = null) {
  const marketCap = dexscreener.resolveOperationalMarketCap(bestPair) || 0;
  const now = Date.now();
  const filledVolumes = buildPriorityVolumeWindows(bestPair, token, now);
  const vol5m = filledVolumes.vol5m;
  const vol1h = filledVolumes.vol1h;
  const vol6h = filledVolumes.vol6h;
  const vol24h = filledVolumes.vol24h;
  const pchange1h = toNumber(bestPair?.priceChange?.h1);
  const pchange6h = toNumber(bestPair?.priceChange?.h6);
  const pchange24h = toNumber(bestPair?.priceChange?.h24);
  const liquidityUsd = toNumber(bestPair?.liquidity?.usd);
  const txns1hBuys = toNumber(bestPair?.txns?.h1?.buys);
  const txns1hSells = toNumber(bestPair?.txns?.h1?.sells);
  const txns24hBuys = toNumber(bestPair?.txns?.h24?.buys);
  const txns24hSells = toNumber(bestPair?.txns?.h24?.sells);

  const applyLowActivityCooldown = (delayMs, randomValue = Math.random()) => {
    const minimumDelayMs = getLowActivityMinimumRecheckMs(token, vol24h, { vol1h, vol6h });
    const safeDelayMs = normalizeDelayMs(delayMs, minimumDelayMs || LOOP_INTERVAL_MS);
    if (minimumDelayMs > safeDelayMs) {
      return addPriorityJitter(minimumDelayMs, LOW_ACTIVITY_JITTER_MS, randomValue);
    }
    return safeDelayMs;
  };

  const maybeSuppressLowActivity = (snapshot) => {
    if (!isLowActivityAutoToken(token, vol24h, { vol1h, vol6h })) {
      return snapshot;
    }

    const baseDelayMs = snapshot?.nextEvaluationAt instanceof Date
      ? normalizeDelayMs(snapshot.nextEvaluationAt.getTime() - now, LOW_ACTIVITY_RECHECK_MS)
      : LOW_ACTIVITY_RECHECK_MS;

    return {
      ...snapshot,
      monitorPriority: 'low',
      nextEvaluationAt: new Date(now + applyLowActivityCooldown(baseDelayMs)),
      eligibleForMonitoring: false,
      eligibilityState: 'dex-low-activity',
      suppressedReason: 'low_activity_24h',
    };
  };

  if (!(marketCap > 0)) {
    return {
      marketCap: null,
      vol5m,
      vol1h,
      vol6h,
      vol24h,
      pchange1h,
      pchange6h,
      pchange24h,
      liquidityUsd,
      txns1hBuys,
      txns1hSells,
      txns24hBuys,
      txns24hSells,
      monitorPriority: 'dormant',
      nextEvaluationAt: new Date(Date.now() + addPriorityJitter(DORMANT_RECHECK_MS, DORMANT_JITTER_MS)),
      eligibleForMonitoring: false,
      eligibilityState: 'dex-known-no-mcap',
      suppressedReason: 'mcap_unavailable',
    };
  }

  if (marketCap < 30000) {
    const nextLowMs = marketCap >= 15000
      || isManualSource(token)
      || isLowDustProtectedByMigrationGrace(token, marketCap, now)
      ? addPriorityJitter(LOW_NEAR_RECHECK_MS, LOW_NEAR_JITTER_MS)
      : addPriorityJitter(LOW_DUST_RECHECK_MS, LOW_DUST_JITTER_MS);

    return maybeSuppressLowActivity({
      marketCap,
      vol5m,
      vol1h,
      vol6h,
      vol24h,
      pchange1h,
      pchange6h,
      pchange24h,
      liquidityUsd,
      txns1hBuys,
      txns1hSells,
      txns24hBuys,
      txns24hSells,
      monitorPriority: 'low',
      nextEvaluationAt: new Date(now + applyLowActivityCooldown(nextLowMs)),
      eligibleForMonitoring: true,
      eligibilityState: 'dex-low',
      suppressedReason: null,
    });
  }

  if (marketCap < 100000) {
    let nextMs = NORMAL_RECHECK_MS;
    if ((pchange6h || 0) >= 200) {
      nextMs = Math.min(nextMs, NORMAL_BOOST_6H_RECHECK_MS);
    }
    if ((pchange1h || 0) >= 150) {
      nextMs = Math.min(nextMs, NORMAL_BOOST_1H_RECHECK_MS);
    }

    return maybeSuppressLowActivity({
      marketCap,
      vol5m,
      vol1h,
      vol6h,
      vol24h,
      pchange1h,
      pchange6h,
      pchange24h,
      liquidityUsd,
      txns1hBuys,
      txns1hSells,
      txns24hBuys,
      txns24hSells,
      monitorPriority: 'normal',
      nextEvaluationAt: new Date(now + applyLowActivityCooldown(nextMs)),
      eligibleForMonitoring: true,
      eligibilityState: 'dex-normal',
      suppressedReason: null,
    });
  }

  let nextHighMs = HIGH_HOT_RECHECK_MS;
  if ((vol6h || 0) < 15000) {
    nextHighMs = HIGH_VERY_LOW_VOL_RECHECK_MS;
  } else if ((vol6h || 0) < 30000) {
    nextHighMs = HIGH_LOW_VOL_RECHECK_MS;
  }

  return maybeSuppressLowActivity({
    marketCap,
    vol5m,
    vol1h,
    vol6h,
    vol24h,
    pchange1h,
    pchange6h,
    pchange24h,
    liquidityUsd,
    txns1hBuys,
    txns1hSells,
    txns24hBuys,
    txns24hSells,
    monitorPriority: 'high',
    nextEvaluationAt: new Date(now + applyLowActivityCooldown(nextHighMs)),
    eligibleForMonitoring: true,
    eligibilityState: 'dex-high',
    suppressedReason: null,
  });
}

function applyLowActivityCooldownForVol24h(delayMs, vol24h, token = null) {
  const minimumDelayMs = getLowActivityMinimumRecheckMs(token, vol24h);
  const safeDelayMs = normalizeDelayMs(delayMs, minimumDelayMs || LOOP_INTERVAL_MS);
  return minimumDelayMs > 0
    ? Math.max(safeDelayMs, minimumDelayMs)
    : safeDelayMs;
}

function getRetryMsForPriority(priority) {
  switch (String(priority || '').trim().toLowerCase()) {
    case 'high':
      return HIGH_HOT_RECHECK_MS;
    case 'normal':
      return NORMAL_RECHECK_MS;
    case 'low':
      return LOW_NEAR_RECHECK_MS;
    case 'dormant':
    default:
      return DORMANT_RECHECK_MS;
  }
}

function shouldFastRetryManualBootstrap(token) {
  return isManualSource(token)
    && !token?.last_eligible_at;
}

function shouldFastRetryMigratedBootstrap(token) {
  return String(token?.source || '').trim().toLowerCase() === 'pumpfun-migrated'
    && isMigrationGraceActive(token)
    && !token?.last_eligible_at;
}

function getRateLimitedRetryMs(token) {
  const marketCap = Number(token?.last_mcap || 0);
  const priority = String(token?.monitor_priority || '').trim().toLowerCase();
  const lowDustProtected = isLowDustProtectedByMigrationGrace(token, marketCap);
  const lastVol24h = Number(token?.last_vol_24h);

  if (shouldFastRetryManualBootstrap(token)) {
    return RATE_LIMIT_MANUAL_RECHECK_MS;
  }

  if (shouldFastRetryMigratedBootstrap(token)) {
    return RATE_LIMIT_LOW_NEAR_RECHECK_MS;
  }

  if (isLowActivityAutoToken(token, lastVol24h)) {
    return LOW_ACTIVITY_RECHECK_MS;
  }

  if (priority === 'high' || marketCap >= 100000) {
    return applyLowActivityCooldownForVol24h(RATE_LIMIT_HIGH_RECHECK_MS, lastVol24h, token);
  }

  if (priority === 'normal' || marketCap >= 30000) {
    return applyLowActivityCooldownForVol24h(RATE_LIMIT_NORMAL_RECHECK_MS, lastVol24h, token);
  }

  if (marketCap >= 15000 || lowDustProtected) {
    return RATE_LIMIT_LOW_NEAR_RECHECK_MS;
  }

  if (marketCap > 0) {
    return RATE_LIMIT_LOW_DUST_RECHECK_MS;
  }

  return DORMANT_RECHECK_MS;
}

function getDexUnavailableRetryMs(token, options = {}) {
  const throttleMode = options.throttleMode
    || dexscreener.getThrottleState().mode;
  if (throttleMode !== 'normal') {
    return getRateLimitedRetryMs(token);
  }

  if (shouldFastRetryMigratedBootstrap(token)) {
    return LOW_NEAR_RECHECK_MS;
  }

  if (shouldFastRetryManualBootstrap(token)) {
    return MANUAL_BOOTSTRAP_RECHECK_MS;
  }

  if (isLowActivityAutoToken(token, token?.last_vol_24h)) {
    return LOW_ACTIVITY_RECHECK_MS;
  }

  return applyLowActivityCooldownForVol24h(
    getRetryMsForPriority(token.monitor_priority),
    token?.last_vol_24h,
    token,
  );
}

function getThrottleTokenBucket(token) {
  const source = String(token?.source || '').trim().toLowerCase();
  const priority = String(token?.monitor_priority || '').trim().toLowerCase();
  const marketCap = Number(token?.last_mcap || 0);
  const lowDustProtected = isLowDustProtectedByMigrationGrace(token, marketCap);

  if (source === 'user-manual') return 'manual';
  if (isLowActivityAutoToken(token, token?.last_vol_24h)) return 'low-dust';
  if (priority === 'high' || marketCap >= 100000) return 'high';
  if (priority === 'normal' || marketCap >= 30000) return 'normal';
  if (marketCap >= 15000 || lowDustProtected) return 'low-near';
  if (marketCap > 0) return 'low-dust';
  return 'other';
}

function isTokenAllowedByThrottle(token, throttleState = { mode: 'normal' }) {
  const bucket = getThrottleTokenBucket(token);
  const mode = String(throttleState?.mode || 'normal').trim().toLowerCase();
  const phase = String(throttleState?.recoveryPhase || '').trim().toLowerCase();

  if (mode === 'normal') {
    return true;
  }

  if (bucket === 'manual') {
    return true;
  }

  if (mode === 'cooldown') {
    return bucket === 'high';
  }

  if (phase === 'high-manual') {
    return bucket === 'high';
  }

  if (phase === 'normal') {
    return bucket === 'high' || bucket === 'normal';
  }

  if (phase === 'low-near') {
    return bucket === 'high' || bucket === 'normal' || bucket === 'low-near';
  }

  if (phase === 'low-dust') {
    return bucket === 'high' || bucket === 'normal' || bucket === 'low-near' || bucket === 'low-dust';
  }

  return bucket === 'high';
}

function getThrottleTokenRank(token, throttleState = { mode: 'normal' }) {
  const bucket = getThrottleTokenBucket(token);
  const phase = String(throttleState?.recoveryPhase || '').trim().toLowerCase();

  if (bucket === 'manual') return 0;
  if (bucket === 'high') return 1;
  if (bucket === 'normal') return 2;
  if (bucket === 'low-near') return 3;
  if (bucket === 'low-dust') return phase === 'low-dust' ? 4 : 5;
  return 6;
}

function buildEvaluationErrorResult(token = {}, error = null, nowMs = Date.now()) {
  const wasEligible = token.eligible_for_monitoring === true;
  const previousPriority = token.monitor_priority || null;

  return {
    eligibilityState: 'evaluation-error',
    eligibleForMonitoring: wasEligible,
    suppressedReason: wasEligible ? null : 'evaluation_error',
    monitorPriority: previousPriority || (wasEligible ? 'normal' : 'dormant'),
    nextEvaluationAt: new Date(nowMs + ERROR_RECHECK_MS),
    lastEvaluationError: error?.message || String(error || 'evaluation_error'),
    evaluationErrorCount: (token.evaluation_error_count || 0) + 1,
  };
}

function prioritizeTokensForThrottle(tokens, throttleState = { mode: 'normal' }, limit = MAX_TOKEN_BUDGET_PER_CYCLE) {
  const safeLimit = Math.max(1, Number(limit) || MAX_TOKEN_BUDGET_PER_CYCLE);
  return [...(Array.isArray(tokens) ? tokens : [])]
    .filter((token) => isTokenAllowedByThrottle(token, throttleState))
    .sort((a, b) => {
      const rankDelta = getThrottleTokenRank(a, throttleState) - getThrottleTokenRank(b, throttleState);
      if (rankDelta !== 0) return rankDelta;

      const nextEvalDelta = new Date(a?.next_evaluation_at || 0).getTime() - new Date(b?.next_evaluation_at || 0).getTime();
      if (nextEvalDelta !== 0) return nextEvalDelta;

      return Number(b?.last_mcap || 0) - Number(a?.last_mcap || 0);
    })
    .slice(0, safeLimit);
}

async function evaluateDexUnavailableToken(token, traceInitialEval) {
  if (isGmgnDexUnavailableZombie(token)) {
    const blockedToken = await maybeAutoBlockGmgnDexUnavailableLowLiquidity(token);
    if (blockedToken) {
      return blockedToken;
    }

    status.totalIneligible++;
    return tokenCatalog.applyEvaluationResult(token.address, {
      eligibilityState: 'gmgn-dex-unavailable-zombie',
      eligibleForMonitoring: false,
      suppressedReason: GMGN_DEX_UNAVAILABLE_ZOMBIE_REASON,
      monitorPriority: 'dormant',
      nextEvaluationAt: new Date(Date.now() + addPriorityJitter(DORMANT_RECHECK_MS, DORMANT_JITTER_MS)),
      lastEvaluationError: 'dex_unavailable',
      evaluationErrorCount: (token.evaluation_error_count || 0) + 1,
    });
  }

  const retryMs = getDexUnavailableRetryMs(token);
  if (traceInitialEval) {
    logTrace('catalog_eval_result', {
      tokenAddress: token.address,
      source: token.source || null,
      result: 'dex-unavailable',
      previousEligibilityState: token.eligibility_state || null,
      previousMarketCap: token.last_mcap == null ? null : Number(token.last_mcap),
      nextEvaluationAt: new Date(Date.now() + retryMs).toISOString(),
    }, { level: 'warn' });
  }
  return tokenCatalog.applyEvaluationResult(token.address, {
    eligibilityState: 'dex-unavailable',
    eligibleForMonitoring: Boolean(token.eligible_for_monitoring),
    suppressedReason: 'dex_unavailable',
    monitorPriority: token.monitor_priority || 'dormant',
    nextEvaluationAt: new Date(Date.now() + retryMs),
    lastEvaluationError: 'dex_unavailable',
    evaluationErrorCount: (token.evaluation_error_count || 0) + 1,
  });
}

async function fetchGmgnZombieTokenInfo(token, client = getDefaultGmgnClient()) {
  return client.fetchTokenInfo({
    chain: token?.chain || 'solana',
    address: token?.address,
  });
}

async function maybeAutoBlockGmgnDexUnavailableLowLiquidity(token) {
  let gmgnInfo = null;
  try {
    gmgnInfo = await fetchGmgnZombieTokenInfo(token);
  } catch (error) {
    console.warn(`[CatalogWorker] Failed to fetch GMGN liquidity for dex-unavailable zombie ${token.address}: ${error.message}`);
    return null;
  }

  const snapshot = buildGmgnDexUnavailableMarketSnapshot(token, gmgnInfo);
  if (!(snapshot.mcap != null
    && snapshot.liquidityUsd != null
    && snapshot.liquidityUsd < GMGN_DEX_UNAVAILABLE_ZOMBIE_LOW_LIQUIDITY_USD)) {
    return null;
  }

  const label = buildGmgnDexUnavailableLowLiquidityLabel(snapshot);
  await adminBlockedToken.add({
    address: token.address,
    label,
    createdBy: null,
    evidence: buildGmgnDexUnavailableLowLiquidityEvidence(token, gmgnInfo, snapshot, label),
  });

  return tokenCatalog.applyEvaluationResult(token.address, {
    eligibilityState: 'admin-blocked',
    eligibleForMonitoring: false,
    suppressedReason: 'admin_blocked',
    monitorPriority: 'dormant',
    nextEvaluationAt: new Date(Date.now() + (GMGN_DEX_UNAVAILABLE_ZOMBIE_BLOCK_YEARS * 365 * 24 * 60 * 60 * 1000)),
    lastEvaluationError: null,
    evaluationErrorCount: 0,
    symbol: gmgnInfo?.symbol || token?.symbol || null,
    name: gmgnInfo?.name || token?.name || null,
  });
}

async function evaluateDexMissingToken(token, gmgnInfo, traceInitialEval) {
  const gmgnFallbackToken = await evaluateManualGmgnFallback(token, gmgnInfo, traceInitialEval, 'dex-missing');
  if (gmgnFallbackToken) {
    return gmgnFallbackToken;
  }

  status.totalIneligible++;
  const nextRetryMs = shouldFastRetryManualBootstrap(token)
    ? MANUAL_BOOTSTRAP_RECHECK_MS
    : DORMANT_RECHECK_MS;
  if (traceInitialEval) {
    logTrace('catalog_eval_result', {
      tokenAddress: token.address,
      source: token.source || null,
      result: 'dex-missing',
      previousEligibilityState: token.eligibility_state || null,
      previousMarketCap: token.last_mcap == null ? null : Number(token.last_mcap),
      nextEvaluationAt: new Date(Date.now() + nextRetryMs).toISOString(),
    }, { level: 'warn' });
  }
  return tokenCatalog.applyEvaluationResult(token.address, {
    eligibilityState: 'dex-missing',
    eligibleForMonitoring: false,
    suppressedReason: 'dex_pair_missing',
    monitorPriority: 'dormant',
    nextEvaluationAt: new Date(Date.now() + nextRetryMs),
    lastEvaluationError: null,
    evaluationErrorCount: 0,
  });
}

async function evaluateTokenWithData(token, data) {
  const traceInitialEval = shouldTraceInitialEvalOnly(token);
  let manualGmgnInfo = shouldCheckManualGmgnBeforeDex(token)
    ? await fetchManualGmgnTokenInfo(token)
    : null;

  const gmgnManualPreMigrationToken = await evaluateManualPreMigrationWithGmgn(token, manualGmgnInfo, traceInitialEval);
  if (gmgnManualPreMigrationToken) {
    return gmgnManualPreMigrationToken;
  }

  if (!data) {
    if (!manualGmgnInfo) {
      manualGmgnInfo = await fetchManualGmgnTokenInfo(token);
    }
    return evaluateDexUnavailableWithManualFallback(token, manualGmgnInfo, traceInitialEval);
  }

  const bestPair = dexscreener.getBestPair(data, token.chain || 'solana');

  if (!bestPair) {
    if (!manualGmgnInfo) {
      manualGmgnInfo = await fetchManualGmgnTokenInfo(token);
    }
    return evaluateDexMissingToken(token, manualGmgnInfo, traceInitialEval);
  }

  const snapshot = derivePrioritySnapshot(bestPair, token);
  const marketCap = snapshot.marketCap;
  const isEligible = snapshot.eligibleForMonitoring;
  const crossedDashboardThreshold = !token?.last_eligible_at && isEligible && marketCap >= 30000;

  if (isEligible) status.totalEligible++;
  else status.totalIneligible++;

  if (traceInitialEval) {
    logTrace('catalog_eval_result', {
      tokenAddress: token.address,
      source: token.source || null,
      result: snapshot.eligibilityState,
      dexId: bestPair.dexId || null,
      pairAddress: bestPair.pairAddress || null,
      marketCap,
      eligibleForMonitoring: isEligible,
      monitorPriority: snapshot.monitorPriority,
      nextEvaluationAt: snapshot.nextEvaluationAt?.toISOString?.() || null,
    });
  }

  if (crossedDashboardThreshold) {
    logTrace('dashboard_eligible_first_seen', {
      tokenAddress: token.address,
      source: token.source || null,
      dexId: bestPair.dexId || null,
      pairAddress: bestPair.pairAddress || null,
      marketCap,
      eligibilityState: snapshot.eligibilityState,
      monitorPriority: snapshot.monitorPriority,
    });
  }

  const socialLinks = extractDexSocialLinks(bestPair);
  const updatedToken = await tokenCatalog.applyEvaluationResult(token.address, {
    evaluationSource: 'dexscreener',
    eligibilityState: snapshot.eligibilityState,
    eligibleForMonitoring: snapshot.eligibleForMonitoring,
    suppressedReason: snapshot.suppressedReason,
    monitorPriority: snapshot.monitorPriority,
    nextEvaluationAt: snapshot.nextEvaluationAt,
    lastEvaluationError: null,
    evaluationErrorCount: 0,
    symbol: bestPair.baseToken?.symbol || null,
    name: bestPair.baseToken?.name || null,
    pairAddress: bestPair.pairAddress || null,
    pairUrl: bestPair.url || null,
    imageUrl: bestPair.info?.imageUrl || null,
    twitterUrl: socialLinks.twitterUrl,
    communityUrl: socialLinks.communityUrl,
    mcap: marketCap,
    price: bestPair.priceUsd || null,
    vol5m: snapshot.vol5m,
    vol1h: snapshot.vol1h,
    vol6h: snapshot.vol6h,
    vol24h: snapshot.vol24h,
    priceChange1h: snapshot.pchange1h,
    priceChange6h: snapshot.pchange6h,
    priceChange24h: snapshot.pchange24h,
    liquidityUsd: snapshot.liquidityUsd,
    txns1hBuys: snapshot.txns1hBuys,
    txns1hSells: snapshot.txns1hSells,
    txns24hBuys: snapshot.txns24hBuys,
    txns24hSells: snapshot.txns24hSells,
    tokenCreatedAt: toNumber(bestPair.pairCreatedAt),
  });

  const marketSnapshotPayload = {
    tokenAddress: token.address,
    pairAddress: bestPair.pairAddress || null,
    mcap: marketCap,
    price: bestPair.priceUsd || null,
    vol5m: snapshot.vol5m,
    vol1h: snapshot.vol1h,
    vol6h: snapshot.vol6h,
    vol24h: snapshot.vol24h,
    source: 'dexscreener',
  };

  await tokenMarketBucket1m.upsertSnapshotBucket(marketSnapshotPayload);
  await tokenMarketVolumeBucket1m.upsertSnapshotBucket(marketSnapshotPayload);

  const postBucketAutoBlockToken = await handlePostBucketAutoBlocks(token, updatedToken, bestPair, snapshot);
  if (postBucketAutoBlockToken) {
    return postBucketAutoBlockToken;
  }

  try {
    await userAlertMatcher.evaluateUpdatedToken({
      tokenBefore: token,
      tokenAfter: updatedToken,
    });
  } catch (error) {
    console.error(`[CatalogWorker] Failed to evaluate per-user alerts for ${token.address}:`, error.message);
  }

  return updatedToken;
}

function getDexPriorityHint(token) {
  const marketCap = Number(token?.last_mcap || 0);
  const priority = String(token?.monitor_priority || '').trim().toLowerCase();
  const vol6h = Number(token?.last_vol_6h || 0);
  const lowDustProtected = isLowDustProtectedByMigrationGrace(token, marketCap);

  if (isLowActivityAutoToken(token, token?.last_vol_24h)) {
    return 'low-activity';
  }

  if (priority === 'high' || marketCap >= 100000) {
    if (vol6h < 15000) return 'high-cold';
    if (vol6h < 30000) return 'high-warm';
    return 'high-hot';
  }

  if (priority === 'normal' || marketCap >= 30000) {
    return 'normal';
  }

  if (marketCap >= 15000 || lowDustProtected) {
    return 'low-near';
  }

  if (marketCap > 0) {
    return 'low-dust';
  }

  return 'dormant';
}

function shouldTraceTokenEvaluation(token) {
  if (!shouldTraceAddress(token?.address)) {
    return false;
  }

  const source = String(token?.source || '').trim().toLowerCase();
  if (source === 'pumpfun-migrated') {
    return true;
  }

  return isTraceDiscoveryEnabled()
    && source === 'dexscreener-discovery'
    && String(token?.address || '').trim().toLowerCase().endsWith('pump');
}

function shouldTraceInitialEvalOnly(token) {
  return shouldTraceTokenEvaluation(token) && !token?.last_evaluated_at;
}

async function runOnce() {
  if (!running) return;

  const cycleStartedAt = Date.now();
  const throttleState = dexscreener.getThrottleState();
  const throttleActive = throttleState.mode !== 'normal';
  const dueSummaryPromise = tokenCatalog.countDueForEvaluationSummary();
  const throttleListLimit = Math.max(
    MAX_TOKEN_BUDGET_PER_CYCLE,
    Math.min(THROTTLE_LIST_LIMIT_CAP, MAX_TOKEN_BUDGET_PER_CYCLE * THROTTLE_LIST_LIMIT_MULTIPLIER)
  );
  const listedDue = await tokenCatalog.listDueForEvaluation(
    throttleActive ? throttleListLimit : MAX_TOKEN_BUDGET_PER_CYCLE
  );
  const due = throttleActive
    ? prioritizeTokensForThrottle(listedDue, throttleState, MAX_TOKEN_BUDGET_PER_CYCLE)
    : listedDue;
  const dueSummary = await dueSummaryPromise;
  const processedByPriority = summarizePriorityCounts(due);
  const backlogByPriority = subtractPriorityCounts(dueSummary.byPriority, processedByPriority);
  const totalDueCount = Number(dueSummary.total) || 0;

  status.lastRunAt = new Date(cycleStartedAt).toISOString();
  status.lastProcessed = due.length;
  status.lastDueCount = due.length;
  status.lastTotalDueCount = totalDueCount;
  status.lastBacklogCount = Math.max(0, totalDueCount - due.length);
  status.lastRateLimitActive = throttleState.mode === 'cooldown';
  status.lastRateLimitBackoffRemainingMs = Number(throttleState.backoffRemainingMs) || 0;
  status.lastRateLimitFilteredCount = Math.max(0, listedDue.length - due.length);
  status.lastThrottleMode = throttleState.mode || 'normal';
  status.lastRecoveryPhase = throttleState.recoveryPhase || null;
  status.lastThrottleBatchDelayMs = Number(throttleState.batchDelayMs) || DEX_BATCH_DELAY_MS;
  status.lastDueByPriority = processedByPriority;
  status.lastBacklogByPriority = backlogByPriority;
  status.lastMaxOverdueMs = Number(dueSummary.maxOverdueMs) || 0;
  status.lastMaxOverdueMsByPriority = dueSummary.maxOverdueMsByPriority || emptyPriorityCounts();
  status.lastDexBatchCount = Math.ceil(due.length / DEX_BATCH_LIMIT);
  status.lastProcessBatchCount = 0;
  status.lastYoungExtremeChurnAlertSuppressed = 0;
  status.lastYoungExtremeChurnAutoBlocked = 0;
  status.totalProcessed += due.length;

  for (let index = 0; index < due.length; index += DEX_BATCH_LIMIT) {
    const fetchBatch = due.slice(index, index + DEX_BATCH_LIMIT);
    const priorityByAddress = new Map(
      fetchBatch.map((token) => [token.address, getDexPriorityHint(token)])
    );
    const dataByAddress = await dexscreener.batchGetTokens(
      fetchBatch.map((token) => token.address),
      { chain: 'solana', priorityByAddress, delayMs: throttleState.batchDelayMs || DEX_BATCH_DELAY_MS }
    );

    for (let processIndex = 0; processIndex < fetchBatch.length; processIndex += CONCURRENCY) {
      status.lastProcessBatchCount += 1;
      const processBatch = fetchBatch.slice(processIndex, processIndex + CONCURRENCY);
      await Promise.all(processBatch.map(async (token) => {
        try {
          if (shouldTraceInitialEvalOnly(token)) {
            logTrace('catalog_eval_start', {
              tokenAddress: token.address,
              source: token.source || null,
              monitorPriority: token.monitor_priority || null,
              previousEligibilityState: token.eligibility_state || null,
              previousMarketCap: token.last_mcap == null ? null : Number(token.last_mcap),
            });
          }
          await evaluateTokenWithData(token, dataByAddress.get(token.address) || null);
        } catch (err) {
          status.totalErrors++;
          await tokenCatalog.applyEvaluationResult(token.address, buildEvaluationErrorResult(token, err));
          console.error(`[CatalogWorker] Failed to evaluate ${token.address}:`, err.message);
        }
      }));
    }

  }

  const cycleFinishedAt = Date.now();
  if (throttleState.mode === 'recovery') {
    dexscreener.completeRecoveryCycle(cycleFinishedAt);
  }
  status.lastCompletedAt = new Date(cycleFinishedAt).toISOString();
  status.lastRunDurationMs = cycleFinishedAt - cycleStartedAt;
  status.lastLoopOverrunMs = Math.max(0, status.lastRunDurationMs - LOOP_INTERVAL_MS);
  return computeNextDelayMs(status.lastRunDurationMs);
}

function schedule(delayMs = LOOP_INTERVAL_MS) {
  if (!running) return;
  const appliedDelayMs = normalizeDelayMs(delayMs);
  status.lastScheduledDelayMs = appliedDelayMs;
  timer = setTimeout(async () => {
    let nextDelayMs = LOOP_INTERVAL_MS;
    try {
      nextDelayMs = await runOnce();
    } finally {
      schedule(nextDelayMs);
    }
  }, appliedDelayMs);
}

function start() {
  if (running) return;
  running = true;
  status.running = true;
  schedule();
  console.log('[CatalogWorker] Started');
}

function stop() {
  running = false;
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function clearManualGmgnCachesForTest() {
  liveManualAddressCache.clear();
  manualGmgnTokenInfoInflight.clear();
  manualGmgnTokenInfoQueue.length = 0;
  manualGmgnTokenInfoActive = 0;
}

function getStatus() {
  return { ...status };
}

module.exports = {
  start,
  stop,
  getStatus,
  runOnce,
  __private: {
    addPriorityJitter,
    computeNextDelayMs,
    derivePrioritySnapshot,
    getLowActivityMinimumRecheckMs,
    LOW_ACTIVITY_24H_MAX_VOL,
    LOW_ACTIVITY_JITTER_MS,
    LOW_ACTIVITY_RECHECK_MS,
    applyLowActivityCooldownForVol24h,
    getDexUnavailableRetryMs,
    getDexPriorityHint,
    getGraceUntilMs,
    isLowDustProtectedByMigrationGrace,
    isLowActivityAutoToken,
    isGmgnDexUnavailableZombie,
    setDefaultGmgnClientForTest,
    isManualSource,
    hasYoungLowLiquidityExemptSuffix,
    shouldCheckManualGmgnBeforeDex,
    isMigrationGraceActive,
    assessYoungLowLiquidity,
    buildYoungLowLiquidityLabel,
    assessYoungExtremeChurn,
    buildYoungExtremeChurnLabel,
    clearYoungExtremeChurnState,
    clearManualGmgnCachesForTest,
    getYoungExtremeChurnState,
    recordYoungExtremeChurnSuspicion,
    getRateLimitedRetryMs,
    getThrottleTokenBucket,
    getThrottleTokenRank,
    buildEvaluationErrorResult,
    MIGRATION_GRACE_FLOOR_MS,
    isTokenAllowedByThrottle,
    normalizeDelayMs,
    prioritizeTokensForThrottle,
    evaluateTokenWithData,
  },
};
