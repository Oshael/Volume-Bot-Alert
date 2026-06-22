const { isValidAddress } = require('../models/user-token');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenCatalog = require('../models/token-catalog');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const gmgnClient = require('./gmgn-client');
const gmgnDiscoveryScheduler = require('./gmgn-discovery-scheduler');
const gmgnPanelStateManager = require('./gmgn-panel-state-manager');
const gmgnRiskReviewQueue = require('./gmgn-risk-review-queue');
const userAlertMatcher = require('./user-alert-matcher');
const { classifyTokenJunk } = require('./token-junk-metric');
const { fillYoungTokenVolumeWindows } = require('./young-token-volume-fill');
const {
  isVolume24hCoherentWithShorterWindows,
  normalizeVolume24hWithShorterWindows,
} = require('./volume-window-consistency');
const {
  AUTO_BLOCK_LABEL_PREFIXES,
  buildCommaSuffixAutoBlockLabel,
  buildPrefixedAutoBlockLabel,
} = require('./auto-block-rule-labels');

const DEFAULT_ALERT_EVALUATION_MIN_INTERVAL_MS = 3000;
const DEFAULT_ACTIVE_DEX_RECHECK_MS = 30000;
const DEFAULT_PANEL_STALE_AFTER_MS = 15000;
const DEFAULT_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE = 5;
const LOW_ACTIVITY_24H_MAX_VOL = 5000;
const LOW_ACTIVITY_RECHECK_MS = 3 * 60 * 1000;
const GMGN_RISK_ENRICHMENT_SUPPRESSION_REASON = 'gmgn_needs_risk_enrichment';
const GMGN_NON_LAUNCH_GRACE_SUPPRESSION_REASON = 'gmgn_non_launch_grace_period';
const GMGN_NON_LAUNCH_GRACE_MS = 15 * 60 * 1000;
const GMGN_ONE_MINUTE_ONLY_OLD_TOKEN_MIN_AGE_HOURS = 24;
const GMGN_YOUNG_TOKEN_MAX_AGE_HOURS = 2;
const GMGN_RISK_LOOKUP_MAX_AGE_HOURS = 6;
const GMGN_YOUNG_VOL_1H_TO_MCAP_RATIO = 10;
const GMGN_YOUNG_VOL_24H_TO_MCAP_RATIO = 20;
const GMGN_RISK_LOOKUP_MIN_MCAP = 100000;
const GMGN_RISK_LOOKUP_MIN_VOL_5M = 50000;
const GMGN_RISK_LOOKUP_VOL_1H_TO_MCAP_RATIO = 3;
const GMGN_SECURITY_TOP_10_HOLDER_RATE_BLOCK_THRESHOLD = 0.70;
const GMGN_LOW_MCAP_HIGH_HOLDER_MAX_MCAP = 150000;
const GMGN_LOW_MCAP_HIGH_HOLDER_MIN_HOLDERS = 1500;
const GMGN_LOW_MCAP_EXTREME_VOL_MAX_AGE_HOURS = 24;
const GMGN_LOW_MCAP_EXTREME_VOL_MAX_MCAP = 100000;
const GMGN_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M = 500000;
const GMGN_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M_TO_MCAP = 4;
const GMGN_LOW_LIQUIDITY_SPAM_MAX_AGE_HOURS = 2;
const GMGN_LOW_LIQUIDITY_SPAM_MAX_LIQUIDITY_USD = 1000;
const GMGN_LOW_LIQUIDITY_SPAM_MAX_MCAP = 150000;
const GMGN_BAD_LIQUIDITY_STATUS_MIN_MCAP = 20000;
const GMGN_BAD_LIQUIDITY_STATUS_MAX_MCAP = 150000;
const GMGN_BAD_LIQUIDITY_STATUS_MIN_BAD_SIGNALS = 2;
const GMGN_NEW_NON_PUMP_MAX_AGE_HOURS = 2;
const GMGN_NEW_NON_PUMP_MIN_LAUNCH_MCAP = 50000;
const GMGN_NEW_NON_PUMP_MAX_LAUNCH_MCAP = 100000;
const GMGN_NEW_NON_PUMP_MIN_VOL_5M = 200000;
const GMGN_NEW_NON_PUMP_MIN_VOL_5M_TO_MCAP = 4;
const GMGN_STAIRCASE_MIN_CANDLES = 12;
const GMGN_STAIRCASE_MIN_RUNUP_RATIO = 1.5;
const GMGN_STAIRCASE_MIN_GREEN_RATIO = 0.85;
const GMGN_STAIRCASE_MIN_UP_STEP_RATIO = 0.85;
const GMGN_STAIRCASE_MAX_RED_CANDLES = 2;
const GMGN_STAIRCASE_MAX_STEP_RATIO = 0.20;
const GMGN_ALERT_SAFEGUARD_REASON = 'gmgn_needs_dex_or_preliminary_review';
const DEX_CONFIRMED_ELIGIBILITY_STATES = new Set(['dex-low', 'dex-normal', 'dex-high']);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function createRiskLookupTokenBudget(limit) {
  const normalizedLimit = parseNonNegativeInteger(limit, DEFAULT_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE);
  return {
    limit: normalizedLimit,
    used: 0,
    skipped: 0,
  };
}

function toFiniteNumberOrNull(value) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanOrNull(value) {
  if (value === true || value === false) {
    return value;
  }
  if (value == null || value === '') {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }
  return null;
}

function readGmgnLiquidityProtectionFields(snapshot = {}) {
  const raw = snapshot.raw && typeof snapshot.raw === 'object' ? snapshot.raw : snapshot;
  return {
    lockPercent: toFiniteNumberOrNull(raw.lock_percent ?? raw.lockPercent),
    burnRatio: toFiniteNumberOrNull(raw.burn_ratio ?? raw.burnRatio),
    burnStatus: normalizeLowerText(raw.burn_status ?? raw.burnStatus),
    creatorClose: toBooleanOrNull(raw.creator_close ?? raw.creatorClose),
    creatorTokenStatus: normalizeLowerText(raw.creator_token_status ?? raw.creatorTokenStatus),
  };
}

function getBadGmgnLiquidityStatusSignals(snapshot = {}) {
  const fields = readGmgnLiquidityProtectionFields(snapshot);
  const signals = [];
  if (fields.lockPercent === 0) signals.push('lock_zero');
  if (fields.burnRatio === 0) signals.push('burn_ratio_zero');
  if (fields.burnStatus === 'none') signals.push('burn_status_none');
  if (fields.creatorClose === true) signals.push('creator_close');
  if (fields.creatorTokenStatus === 'creator_close') signals.push('creator_token_status_close');
  return signals;
}

function toTimestampMsOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function normalizeLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function calculateTokenAgeHours(snapshot, now) {
  const createdAtMs = toTimestampMsOrNull(snapshot?.tokenCreatedAt);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!(createdAtMs > 0) || !(nowMs > createdAtMs)) {
    return null;
  }
  return (nowMs - createdAtMs) / (60 * 60 * 1000);
}

function computeSnapshotVolumeToMcapRatio(volume, marketCap) {
  const parsedVolume = toFiniteNumberOrNull(volume);
  const parsedMarketCap = toFiniteNumberOrNull(marketCap);
  if (!(parsedMarketCap > 0) || !(parsedVolume >= 0)) {
    return null;
  }
  return parsedVolume / parsedMarketCap;
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }
  return address;
}

function normalizeChain(value) {
  const chain = String(value || '').trim().toLowerCase();
  return chain === 'sol' ? 'solana' : chain || 'solana';
}

function resolveTimedOption(optionValue, envName, fallback) {
  return parsePositiveInteger(optionValue || process.env[envName], fallback);
}

function resolveRiskReviewMode(options = {}) {
  if (options.gmgnRiskReviewMode) {
    return String(options.gmgnRiskReviewMode).trim().toLowerCase();
  }
  if (options.gmgnClient) {
    return 'inline';
  }
  return String(process.env.GMGN_RISK_REVIEW_MODE || 'queued').trim().toLowerCase();
}

function resolveRiskLookupBudget(options = {}) {
  if (options.gmgnRiskLookupBudget) {
    return options.gmgnRiskLookupBudget;
  }
  return createRiskLookupTokenBudget(
    options.gmgnRiskLookupTokenLimitPerCycle ?? process.env.GMGN_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE
  );
}

function resolveIngestionOptions(options = {}) {
  return {
    now: options.now || (() => new Date()),
    alertEvaluationMinIntervalMs: resolveTimedOption(options.alertEvaluationMinIntervalMs, 'GMGN_ALERT_EVALUATION_MIN_INTERVAL_MS', DEFAULT_ALERT_EVALUATION_MIN_INTERVAL_MS),
    activeDexRecheckMs: resolveTimedOption(options.activeDexRecheckMs, 'GMGN_ACTIVE_DEX_RECHECK_MS', DEFAULT_ACTIVE_DEX_RECHECK_MS),
    staleAfterMs: resolveTimedOption(options.staleAfterMs, 'GMGN_PANEL_STALE_AFTER_MS', DEFAULT_PANEL_STALE_AFTER_MS),
    evaluationState: options.evaluationState || defaultEvaluationState,
    tokenCatalogModel: options.tokenCatalogModel || tokenCatalog,
    adminBlockedTokenModel: options.adminBlockedTokenModel || adminBlockedToken,
    marketBucketModel: options.marketBucketModel || (options.volumeBucketModel ? null : tokenMarketBucket1m),
    volumeBucketModel: options.volumeBucketModel || tokenMarketVolumeBucket1m,
    alertMatcher: options.alertMatcher || userAlertMatcher,
    gmgnClient: options.gmgnClient || gmgnClient.createGmgnClient(options.gmgnClientOptions || {}),
    scheduler: options.scheduler || gmgnDiscoveryScheduler.createGmgnDiscoveryScheduler(options.schedulerOptions || {}),
    panelStateManager: options.panelStateManager || gmgnPanelStateManager,
    gmgnRiskReviewMode: resolveRiskReviewMode(options),
    gmgnRiskReviewQueue: options.gmgnRiskReviewQueue || gmgnRiskReviewQueue,
    gmgnRiskLookupBudget: resolveRiskLookupBudget(options),
  };
}

const defaultEvaluationState = new Map();

function resolveCatalogSource(tokenBefore, options = {}) {
  const previousSource = String(tokenBefore?.source || '').trim().toLowerCase();
  return previousSource === 'user-manual' || options.manualProtected === true ? 'user-manual' : 'gmgn';
}

function buildCatalogPayload(snapshot, tokenBefore = null, options = {}) {
  return {
    address: normalizeAddress(snapshot.address || snapshot.tokenAddress),
    chain: normalizeChain(snapshot.chain),
    source: resolveCatalogSource(tokenBefore, options),
    symbol: snapshot.symbol || null,
    name: snapshot.name || null,
    pairAddress: snapshot.pairAddress || null,
    pairUrl: snapshot.pairUrl || null,
    imageUrl: snapshot.imageUrl || null,
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
    tokenCreatedAt: toTimestampMsOrNull(snapshot.tokenCreatedAt),
    isActiveMonitorCandidate: true,
  };
}

function buildVolumeBucketPayload(snapshot, now) {
  return {
    tokenAddress: normalizeAddress(snapshot.address || snapshot.tokenAddress),
    ts: now,
    vol1m: snapshot.vol1m,
    vol5m: snapshot.vol5m,
    vol1h: snapshot.vol1h,
    vol6h: snapshot.vol6h,
    vol24h: snapshot.vol24h,
    source: 'gmgn',
  };
}

function buildMarketBucketPayload(snapshot, now) {
  return {
    tokenAddress: normalizeAddress(snapshot.address || snapshot.tokenAddress),
    ts: now,
    pairAddress: snapshot.pairAddress || null,
    mcap: snapshot.mcap,
    price: snapshot.price,
    source: 'gmgn',
  };
}

function preserveExistingPositiveVolumeWindows(snapshot, tokenBefore) {
  if (!tokenBefore) {
    return snapshot;
  }

  const next = { ...snapshot };
  const previousVol5m = toFiniteNumberOrNull(tokenBefore.last_vol_5m);
  if (hasDexConfirmation(tokenBefore) && previousVol5m != null && previousVol5m > 0) {
    next.vol5m = previousVol5m;
  }

  for (const [snapshotKey, catalogKey] of [
    ['vol1h', 'last_vol_1h'],
    ['vol6h', 'last_vol_6h'],
    ['vol24h', 'last_vol_24h'],
  ]) {
    const incoming = toFiniteNumberOrNull(next[snapshotKey]);
    const previous = toFiniteNumberOrNull(tokenBefore[catalogKey]);
    if (incoming === 0 && previous != null && previous > 0) {
      next[snapshotKey] = previous;
    }
  }

  return normalizeVolume24hWithShorterWindows(next, {
    vol24h: tokenBefore.last_vol_24h,
  });
}

function buildPreservedGmgnEvaluation(snapshot, tokenBefore, marketCap, nextEvaluationAt) {
  if (!tokenBefore || tokenBefore.eligible_for_monitoring == null) {
    return null;
  }

  return buildEvaluationPayload(snapshot, {
    eligibilityState: tokenBefore.eligibility_state || resolveEligibilityState(marketCap),
    eligibleForMonitoring: tokenBefore.eligible_for_monitoring === true,
    suppressedReason: tokenBefore.suppressed_reason || null,
    monitorPriority: tokenBefore.monitor_priority || resolveMonitorPriority(marketCap),
    nextEvaluationAt,
  });
}

function deriveGmgnEvaluation(snapshot, tokenBefore, options) {
  const marketCap = toFiniteNumberOrNull(snapshot.mcap);
  const vol24h = toFiniteNumberOrNull(snapshot.vol24h);
  const now = options.now();
  const nonLaunchGraceUntil = resolveGmgnNonLaunchGraceUntil(snapshot, tokenBefore, now);
  const nextEvaluationAt = resolveGmgnNextEvaluationAt(
    tokenBefore,
    new Date(now.getTime() + options.activeDexRecheckMs),
    { preserveEarlier: true }
  );
  const isManual = String(tokenBefore?.source || '').trim().toLowerCase() === 'user-manual';

  if (nonLaunchGraceUntil) {
    return buildEvaluationPayload(snapshot, {
      eligibilityState: 'gmgn-non-launch-grace',
      eligibleForMonitoring: false,
      suppressedReason: GMGN_NON_LAUNCH_GRACE_SUPPRESSION_REASON,
      monitorPriority: resolveMonitorPriority(marketCap),
      nextEvaluationAt: resolveGmgnNextEvaluationAt(tokenBefore, nonLaunchGraceUntil),
    });
  }

  if (!(marketCap > 0)) {
    return buildEvaluationPayload(snapshot, {
      eligibilityState: 'gmgn-known-no-mcap',
      eligibleForMonitoring: false,
      suppressedReason: 'mcap_unavailable',
      monitorPriority: 'dormant',
      nextEvaluationAt,
    });
  }

  if (!isManual && vol24h != null && vol24h >= 0 && vol24h < LOW_ACTIVITY_24H_MAX_VOL) {
    if (!isVolume24hCoherentWithShorterWindows(snapshot)) {
      const preserved = buildPreservedGmgnEvaluation(snapshot, tokenBefore, marketCap, nextEvaluationAt);
      if (preserved) {
        return preserved;
      }
    } else {
      return buildEvaluationPayload(snapshot, {
        eligibilityState: 'gmgn-low-activity',
        eligibleForMonitoring: false,
        suppressedReason: 'low_activity_24h',
        monitorPriority: 'low',
        nextEvaluationAt: resolveGmgnNextEvaluationAt(
          tokenBefore,
          new Date(now.getTime() + LOW_ACTIVITY_RECHECK_MS)
        ),
      });
    }
  }

  if (!isManual && shouldSuppressGmgnForRiskEnrichment(snapshot, now)) {
    return buildEvaluationPayload(snapshot, {
      eligibilityState: 'gmgn-needs-risk-enrichment',
      eligibleForMonitoring: false,
      suppressedReason: GMGN_RISK_ENRICHMENT_SUPPRESSION_REASON,
      monitorPriority: resolveMonitorPriority(marketCap),
      nextEvaluationAt,
    });
  }

  return buildEvaluationPayload(snapshot, {
    eligibilityState: resolveEligibilityState(marketCap),
    eligibleForMonitoring: true,
    suppressedReason: null,
    monitorPriority: resolveMonitorPriority(marketCap),
    nextEvaluationAt,
  });
}

function buildEvaluationPayload(snapshot, base) {
  return {
    ...base,
    evaluationSource: 'gmgn',
    lastEvaluationError: null,
    evaluationErrorCount: 0,
    symbol: snapshot.symbol || null,
    name: snapshot.name || null,
    pairAddress: snapshot.pairAddress || null,
    pairUrl: snapshot.pairUrl || null,
    imageUrl: snapshot.imageUrl || null,
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
    tokenCreatedAt: toTimestampMsOrNull(snapshot.tokenCreatedAt),
  };
}

function resolveMonitorPriority(marketCap) {
  if (marketCap >= 100000) return 'high';
  if (marketCap >= 30000) return 'normal';
  return 'low';
}

function resolveEligibilityState(marketCap) {
  if (marketCap >= 100000) return 'gmgn-high';
  if (marketCap >= 30000) return 'gmgn-normal';
  return 'gmgn-low';
}

function shouldEvaluateAlerts(address, nowMs, options) {
  const previous = options.evaluationState.get(address) || 0;
  if ((nowMs - previous) < options.alertEvaluationMinIntervalMs) {
    return false;
  }
  options.evaluationState.set(address, nowMs);
  return true;
}

function isBlockedToken(row) {
  return String(row?.source || '').trim().toLowerCase() === 'admin-blocked';
}

function getGmgnIntervals(snapshot = {}) {
  const intervals = Array.isArray(snapshot.gmgnIntervals)
    ? snapshot.gmgnIntervals
    : [snapshot.gmgnInterval];
  return [...new Set(intervals
    .map((interval) => String(interval || '').trim().toLowerCase())
    .filter(Boolean))];
}

function isOneMinuteOnlyDiscovery(snapshot = {}) {
  const intervals = getGmgnIntervals(snapshot);
  return intervals.length > 0 && intervals.every((interval) => interval === '1m');
}

function isOldEnoughForOneMinuteOnlyDiscovery(snapshot, now = new Date()) {
  const ageHours = calculateTokenAgeHours(snapshot, now);
  return ageHours != null && ageHours >= GMGN_ONE_MINUTE_ONLY_OLD_TOKEN_MIN_AGE_HOURS;
}

function shouldSkipNewGmgnDiscovery(snapshot, tokenBefore, now = new Date()) {
  return !tokenBefore
    && isOneMinuteOnlyDiscovery(snapshot)
    && !isOldEnoughForOneMinuteOnlyDiscovery(snapshot, now);
}

function resolveGmgnNonLaunchGraceUntil(snapshot = {}, tokenBefore = null, now = new Date()) {
  if (isManualToken(tokenBefore) || isBlockedToken(tokenBefore) || hasDexConfirmation(tokenBefore)) {
    return null;
  }

  const address = snapshot.address || snapshot.tokenAddress || tokenBefore?.address;
  if (!address || hasKnownLaunchSuffix(address)) {
    return null;
  }

  const createdAtMs = toTimestampMsOrNull(snapshot.tokenCreatedAt);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!(createdAtMs > 0) || !(nowMs >= createdAtMs)) {
    return null;
  }

  const graceUntilMs = createdAtMs + GMGN_NON_LAUNCH_GRACE_MS;
  return graceUntilMs > nowMs ? new Date(graceUntilMs) : null;
}

function shouldSuppressGmgnForRiskEnrichment(snapshot = {}, now = new Date()) {
  const ageHours = calculateTokenAgeHours(snapshot, now);
  if (ageHours == null || ageHours >= GMGN_YOUNG_TOKEN_MAX_AGE_HOURS) {
    return false;
  }

  const vol1hToMcap = computeSnapshotVolumeToMcapRatio(snapshot.vol1h, snapshot.mcap);
  const vol24hToMcap = computeSnapshotVolumeToMcapRatio(snapshot.vol24h, snapshot.mcap);
  return (vol1hToMcap != null && vol1hToMcap >= GMGN_YOUNG_VOL_1H_TO_MCAP_RATIO)
    || (vol24hToMcap != null && vol24hToMcap >= GMGN_YOUNG_VOL_24H_TO_MCAP_RATIO);
}

function shouldCheckGmgnRiskData(snapshot = {}, now = new Date()) {
  const ageHours = calculateTokenAgeHours(snapshot, now);
  if (ageHours == null || ageHours >= GMGN_RISK_LOOKUP_MAX_AGE_HOURS) {
    return false;
  }

  const marketCap = toFiniteNumberOrNull(snapshot.mcap);
  const vol5m = toFiniteNumberOrNull(snapshot.vol5m);
  const vol1hToMcap = computeSnapshotVolumeToMcapRatio(snapshot.vol1h, snapshot.mcap);
  const vol24hToMcap = computeSnapshotVolumeToMcapRatio(snapshot.vol24h, snapshot.mcap);
  return (vol1hToMcap != null && vol1hToMcap >= GMGN_YOUNG_VOL_1H_TO_MCAP_RATIO)
    || (vol24hToMcap != null && vol24hToMcap >= GMGN_YOUNG_VOL_24H_TO_MCAP_RATIO)
    || (vol1hToMcap != null && vol1hToMcap >= GMGN_RISK_LOOKUP_VOL_1H_TO_MCAP_RATIO)
    || (marketCap != null && marketCap >= GMGN_RISK_LOOKUP_MIN_MCAP)
    || (vol5m != null && vol5m >= GMGN_RISK_LOOKUP_MIN_VOL_5M);
}

function trySpendGmgnRiskLookupBudget(options, summary) {
  const budget = options.gmgnRiskLookupBudget;
  if (!budget) {
    return true;
  }
  const limit = parseNonNegativeInteger(budget.limit, DEFAULT_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE);
  const used = parseNonNegativeInteger(budget.used, 0);
  if (used >= limit) {
    budget.skipped = parseNonNegativeInteger(budget.skipped, 0) + 1;
    summary.gmgnRiskLookupBudgetSkipped += 1;
    return false;
  }

  budget.used = used + 1;
  summary.gmgnRiskLookupBudgetUsed += 1;
  return true;
}

function buildFreshPreliminaryReviewGuard(address, options) {
  if (!options.gmgnRiskReviewQueue?.hasFreshPassedReview?.(address)) {
    return null;
  }
  return {
    skipped: false,
    security: { cachedPreliminaryReview: true },
    info: { cachedPreliminaryReview: true },
    klineAnalysis: { cachedPreliminaryReview: true },
  };
}

function enqueueGmgnRiskReview(address, snapshot, tokenBefore, options, summary) {
  const result = options.gmgnRiskReviewQueue?.enqueue?.({
    address,
    snapshot,
    tokenBeforeSource: tokenBefore?.source || null,
    tokenBeforeEligibilityState: tokenBefore?.eligibility_state || null,
  }) || { queued: false, reason: 'queue-unavailable' };

  if (result.queued) {
    summary.gmgnRiskReviewQueued += 1;
  } else if (result.reason === 'already-queued') {
    summary.gmgnRiskReviewDeduped += 1;
  } else if (result.reason === 'fresh-passed') {
    summary.gmgnRiskReviewFreshPassed += 1;
    return buildFreshPreliminaryReviewGuard(address, options);
  } else {
    summary.gmgnRiskReviewQueueErrors += 1;
    summary.errorMessages.push(`GMGN risk review queue skipped ${address}: ${result.reason || 'unknown'}`);
  }

  return {
    skipped: false,
    skipReason: result.reason || 'gmgn-risk-review-queued',
    riskReviewQueued: Boolean(result.queued),
  };
}

async function runGmgnPreliminaryRiskReview(address, snapshot, tokenBefore, options, summary) {
  let security = null;
  summary.gmgnSecurityChecks += 1;
  try {
    security = await options.gmgnClient.fetchTokenSecurity({
      chain: normalizeChain(snapshot.chain),
      address,
    });

    if (isGmgnSecurityAutoBlockRisk(security)) {
      await autoBlockGmgnSecurityRisk(address, snapshot, tokenBefore, security, options);
      summary.gmgnSecurityAutoBlocked += 1;
      return {
        skipped: true,
        skipReason: 'gmgn-security-auto-blocked',
        security,
      };
    }
  } catch (error) {
    summary.gmgnSecurityErrors += 1;
    summary.errorMessages.push(`GMGN security check failed for ${address}: ${error.message}`);
  }

  let info = null;
  summary.gmgnInfoChecks += 1;
  try {
    info = await options.gmgnClient.fetchTokenInfo({
      chain: normalizeChain(snapshot.chain),
      address,
    });

    if (isGmgnInfoAutoBlockRisk(info, snapshot)) {
      await autoBlockGmgnInfoRisk(address, snapshot, tokenBefore, info, options);
      summary.gmgnInfoAutoBlocked += 1;
      return {
        skipped: true,
        skipReason: 'gmgn-info-auto-blocked',
        security,
        info,
      };
    }
  } catch (error) {
    summary.gmgnInfoErrors += 1;
    summary.errorMessages.push(`GMGN token info check failed for ${address}: ${error.message}`);
  }

  summary.gmgnKlineChecks += 1;
  try {
    const createdAtMs = toTimestampMsOrNull(snapshot.tokenCreatedAt) || options.now().getTime();
    const candles = await options.gmgnClient.fetchMarketKline({
      chain: normalizeChain(snapshot.chain),
      address,
      resolution: '1m',
      from: Math.max(0, Math.floor((createdAtMs - 60000) / 1000)),
      to: Math.floor(options.now().getTime() / 1000),
    });
    const klineAnalysis = analyzeGmgnKlinePattern(candles);

    if (!isGmgnStaircasePumpRisk(klineAnalysis)) {
      return {
        skipped: false,
        security,
        info,
        klineAnalysis,
      };
    }

    await autoBlockGmgnKlineRisk(address, snapshot, tokenBefore, klineAnalysis, options);
    summary.gmgnKlineAutoBlocked += 1;
    return {
      skipped: true,
      skipReason: 'gmgn-kline-auto-blocked',
      security,
      info,
      klineAnalysis,
    };
  } catch (error) {
    summary.gmgnKlineErrors += 1;
    summary.errorMessages.push(`GMGN kline check failed for ${address}: ${error.message}`);
    return null;
  }
}

function buildGmgnJunkAssessmentInput(snapshot = {}) {
  return {
    address: snapshot.address || snapshot.tokenAddress || null,
    mcap: snapshot.mcap,
    volume1h: snapshot.vol1h,
    volume6h: snapshot.vol6h,
    volume24h: snapshot.vol24h,
    priceChange6h: snapshot.priceChange6h,
    priceChange24h: snapshot.priceChange24h,
    liquidityUsd: snapshot.liquidityUsd,
    txns1hBuys: snapshot.txns1hBuys,
    txns1hSells: snapshot.txns1hSells,
    txns24hBuys: snapshot.txns24hBuys,
    txns24hSells: snapshot.txns24hSells,
  };
}

function assessGmgnJunk(snapshot = {}) {
  return classifyTokenJunk(buildGmgnJunkAssessmentInput(snapshot));
}

function isJunkAssessment(assessment) {
  const label = String(assessment?.label || '').trim().toLowerCase();
  return label === 'junk_probable' || label === 'junk_permanent';
}

function isHighConfidenceJunkAssessment(assessment) {
  return isJunkAssessment(assessment) && String(assessment?.confidence || '').trim().toLowerCase() === 'high';
}

function isManualToken(row) {
  return normalizeLowerText(row?.source) === 'user-manual';
}

async function isManualTokenProtected(address, tokenBefore, options) {
  if (isManualToken(tokenBefore)) {
    return true;
  }

  if (typeof options.tokenCatalogModel?.hasUserManualAddress !== 'function') {
    return false;
  }

  try {
    return await options.tokenCatalogModel.hasUserManualAddress(address);
  } catch (_) {
    return false;
  }
}

function isPumpAddress(address) {
  return hasKnownLaunchSuffix(address);
}

function hasKnownLaunchSuffix(address) {
  const normalized = normalizeLowerText(address);
  return normalized.endsWith('pump')
    || normalized.endsWith('bags')
    || normalized.endsWith('brrr')
    || normalized.endsWith('bonk');
}

function isAutomaticGmgnToken(tokenBefore, tokenAfter) {
  return normalizeLowerText(tokenAfter?.source) === 'gmgn'
    && !isManualToken(tokenBefore)
    && !isManualToken(tokenAfter);
}

function isDexscreenerPairUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return false;
  }

  try {
    const url = new URL(raw);
    return url.hostname === 'dexscreener.com' || url.hostname.endsWith('.dexscreener.com');
  } catch {
    return false;
  }
}

function hasDexConfirmation(row) {
  const state = normalizeLowerText(row?.eligibility_state || row?.eligibilityState);
  return DEX_CONFIRMED_ELIGIBILITY_STATES.has(state)
    || isDexscreenerPairUrl(row?.last_pair_url || row?.pairUrl);
}

function toValidDateOrNull(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function resolveGmgnNextEvaluationAt(tokenBefore, fallbackNextEvaluationAt, options = {}) {
  if (!hasDexConfirmation(tokenBefore) && options.preserveEarlier !== true) {
    return fallbackNextEvaluationAt;
  }

  const existingNextEvaluationAt = toValidDateOrNull(
    tokenBefore?.next_evaluation_at || tokenBefore?.nextEvaluationAt
  );
  if (!existingNextEvaluationAt || existingNextEvaluationAt > fallbackNextEvaluationAt) {
    return fallbackNextEvaluationAt;
  }

  return existingNextEvaluationAt;
}

function hasCompletedGmgnPreliminaryReview(securityGuard) {
  return securityGuard?.skipped === false
    && securityGuard.security
    && securityGuard.info
    && securityGuard.klineAnalysis;
}

function canEvaluateGmgnAlerts(tokenBefore, tokenAfter, securityGuard) {
  if (!isAutomaticGmgnToken(tokenBefore, tokenAfter)) {
    return true;
  }

  return hasDexConfirmation(tokenBefore)
    || hasDexConfirmation(tokenAfter)
    || hasCompletedGmgnPreliminaryReview(securityGuard);
}

function canPersistGmgnMarketBuckets(tokenBefore, tokenAfter, securityGuard) {
  if (!tokenAfter || isBlockedToken(tokenAfter) || tokenAfter.eligible_for_monitoring === false) {
    return false;
  }
  return canEvaluateGmgnAlerts(tokenBefore, tokenAfter, securityGuard);
}

function canPersistGmgnVisualBuckets(tokenAfter, snapshot = {}) {
  if (!tokenAfter || isBlockedToken(tokenAfter) || tokenAfter.eligible_for_monitoring === false) {
    return false;
  }

  return toFiniteNumberOrNull(snapshot.mcap) != null;
}

function isGmgnSecurityAutoBlockRisk(security) {
  const top10HolderRate = toFiniteNumberOrNull(security?.top10HolderRate);
  return top10HolderRate != null && top10HolderRate >= GMGN_SECURITY_TOP_10_HOLDER_RATE_BLOCK_THRESHOLD;
}

function isGmgnInfoAutoBlockRisk(info, snapshot = {}) {
  const holderCount = toFiniteNumberOrNull(info?.holderCount);
  const marketCap = toFiniteNumberOrNull(info?.marketCap) ?? toFiniteNumberOrNull(snapshot.mcap);
  return holderCount != null
    && holderCount >= GMGN_LOW_MCAP_HIGH_HOLDER_MIN_HOLDERS
    && marketCap != null
    && marketCap <= GMGN_LOW_MCAP_HIGH_HOLDER_MAX_MCAP;
}

function isGmgnLowMcapExtremeVolumeRisk(snapshot = {}, now = new Date()) {
  const ageHours = calculateTokenAgeHours(snapshot, now);
  const marketCap = toFiniteNumberOrNull(snapshot.mcap);
  const vol5m = toFiniteNumberOrNull(snapshot.vol5m);
  const vol5mToMcap = computeSnapshotVolumeToMcapRatio(vol5m, marketCap);
  return ageHours != null
    && ageHours < GMGN_LOW_MCAP_EXTREME_VOL_MAX_AGE_HOURS
    && marketCap != null
    && marketCap <= GMGN_LOW_MCAP_EXTREME_VOL_MAX_MCAP
    && vol5m != null
    && vol5m >= GMGN_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M
    && vol5mToMcap != null
    && vol5mToMcap >= GMGN_LOW_MCAP_EXTREME_VOL_MIN_VOL_5M_TO_MCAP;
}

function isGmgnLowLiquiditySpamRisk(address, snapshot = {}, tokenBefore = null, now = new Date()) {
  if (isManualToken(tokenBefore) || isBlockedToken(tokenBefore) || hasDexConfirmation(tokenBefore)) {
    return false;
  }
  if (hasKnownLaunchSuffix(address)) {
    return false;
  }

  const ageHours = calculateTokenAgeHours(snapshot, now);
  const liquidityUsd = toFiniteNumberOrNull(snapshot.liquidityUsd);
  const marketCap = toFiniteNumberOrNull(snapshot.mcap);
  return ageHours != null
    && ageHours < GMGN_LOW_LIQUIDITY_SPAM_MAX_AGE_HOURS
    && liquidityUsd != null
    && liquidityUsd < GMGN_LOW_LIQUIDITY_SPAM_MAX_LIQUIDITY_USD
    && marketCap != null
    && marketCap < GMGN_LOW_LIQUIDITY_SPAM_MAX_MCAP;
}

function isGmgnBadLiquidityStatusMcapBandRisk(address, snapshot = {}, tokenBefore = null, now = new Date()) {
  if (isManualToken(tokenBefore) || isBlockedToken(tokenBefore) || hasDexConfirmation(tokenBefore)) {
    return false;
  }
  if (hasKnownLaunchSuffix(address)) {
    return false;
  }

  const ageHours = calculateTokenAgeHours(snapshot, now);
  if (ageHours == null || ageHours >= GMGN_LOW_LIQUIDITY_SPAM_MAX_AGE_HOURS) {
    return false;
  }

  const marketCap = toFiniteNumberOrNull(snapshot.mcap);
  if (marketCap == null
    || marketCap < GMGN_BAD_LIQUIDITY_STATUS_MIN_MCAP
    || marketCap > GMGN_BAD_LIQUIDITY_STATUS_MAX_MCAP) {
    return false;
  }

  return getBadGmgnLiquidityStatusSignals(snapshot).length >= GMGN_BAD_LIQUIDITY_STATUS_MIN_BAD_SIGNALS;
}

function hasReliableGmgnFiveMinuteVolume(snapshot = {}) {
  const vol1m = toFiniteNumberOrNull(snapshot.vol1m);
  const vol5m = toFiniteNumberOrNull(snapshot.vol5m);
  const vol1h = toFiniteNumberOrNull(snapshot.vol1h);
  if (!(vol5m > 0)) {
    return false;
  }
  if (vol1m != null && vol1m >= vol5m * 0.9) {
    return false;
  }
  if (vol1h != null && vol5m > vol1h) {
    return false;
  }
  return true;
}

function isNewNonPumpHighLaunchMcapRisk(address, snapshot = {}, tokenBefore, now = new Date()) {
  if (isManualToken(tokenBefore) || isBlockedToken(tokenBefore) || hasDexConfirmation(tokenBefore) || isPumpAddress(address)) {
    return false;
  }

  const ageHours = calculateTokenAgeHours(snapshot, now);
  const marketCap = toFiniteNumberOrNull(snapshot.mcap);
  const vol5m = toFiniteNumberOrNull(snapshot.vol5m);
  const vol5mToMcap = computeSnapshotVolumeToMcapRatio(vol5m, marketCap);
  return ageHours != null
    && ageHours < GMGN_NEW_NON_PUMP_MAX_AGE_HOURS
    && marketCap != null
    && marketCap >= GMGN_NEW_NON_PUMP_MIN_LAUNCH_MCAP
    && marketCap <= GMGN_NEW_NON_PUMP_MAX_LAUNCH_MCAP
    && vol5m != null
    && hasReliableGmgnFiveMinuteVolume(snapshot)
    && vol5m >= GMGN_NEW_NON_PUMP_MIN_VOL_5M
    && vol5mToMcap != null
    && vol5mToMcap >= GMGN_NEW_NON_PUMP_MIN_VOL_5M_TO_MCAP;
}

function analyzeGmgnKlinePattern(candles = []) {
  const rows = (Array.isArray(candles) ? candles : [])
    .filter((row) => toFiniteNumberOrNull(row?.open) != null && toFiniteNumberOrNull(row?.close) != null)
    .sort((left, right) => (left.timestampMs || 0) - (right.timestampMs || 0));
  const firstOpen = toFiniteNumberOrNull(rows[0]?.open);
  const lastClose = toFiniteNumberOrNull(rows[rows.length - 1]?.close);
  const runupRatio = firstOpen > 0 && lastClose > 0 ? (lastClose / firstOpen) - 1 : null;
  let green = 0;
  let red = 0;
  let upSteps = 0;
  let downSteps = 0;
  let maxStepRatio = 0;

  rows.forEach((row, index) => {
    const open = toFiniteNumberOrNull(row.open);
    const close = toFiniteNumberOrNull(row.close);
    if (open > 0 && close > open * 1.001) green += 1;
    if (open > 0 && close < open * 0.999) red += 1;

    if (index > 0) {
      const previousClose = toFiniteNumberOrNull(rows[index - 1].close);
      if (previousClose > 0 && close != null) {
        const stepRatio = (close - previousClose) / previousClose;
        if (stepRatio > 0.001) upSteps += 1;
        if (stepRatio < -0.001) downSteps += 1;
        maxStepRatio = Math.max(maxStepRatio, Math.abs(stepRatio));
      }
    }
  });

  const stepCount = Math.max(0, rows.length - 1);
  return {
    candleCount: rows.length,
    green,
    red,
    upSteps,
    downSteps,
    runupRatio,
    greenRatio: rows.length ? green / rows.length : 0,
    upStepRatio: stepCount ? upSteps / stepCount : 0,
    maxStepRatio,
  };
}

function isGmgnStaircasePumpRisk(analysis) {
  return analysis?.candleCount >= GMGN_STAIRCASE_MIN_CANDLES
    && analysis.runupRatio != null
    && analysis.runupRatio >= GMGN_STAIRCASE_MIN_RUNUP_RATIO
    && analysis.greenRatio >= GMGN_STAIRCASE_MIN_GREEN_RATIO
    && analysis.upStepRatio >= GMGN_STAIRCASE_MIN_UP_STEP_RATIO
    && analysis.red <= GMGN_STAIRCASE_MAX_RED_CANDLES
    && analysis.maxStepRatio <= GMGN_STAIRCASE_MAX_STEP_RATIO;
}

function buildGmgnAutoBlockLabel(assessment) {
  const reasonCodes = Array.isArray(assessment?.reasonCodes)
    ? assessment.reasonCodes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return buildCommaSuffixAutoBlockLabel(AUTO_BLOCK_LABEL_PREFIXES.GMGN_AUTO_JUNK, reasonCodes);
}

function buildGmgnSecurityAutoBlockLabel(security) {
  const top10HolderRate = toFiniteNumberOrNull(security?.top10HolderRate);
  if (top10HolderRate == null) {
    return 'gmgn-security:auto-risk';
  }
  const pct = Math.round(top10HolderRate * 10000) / 100;
  return `${AUTO_BLOCK_LABEL_PREFIXES.GMGN_SECURITY_TOP10_HOLDER_RATE}-${pct}%`;
}

function buildGmgnInfoAutoBlockLabel(info, snapshot = {}) {
  const holderCount = Math.round(toFiniteNumberOrNull(info?.holderCount) || 0);
  const marketCap = Math.round(toFiniteNumberOrNull(info?.marketCap) ?? toFiniteNumberOrNull(snapshot.mcap) ?? 0);
  return buildPrefixedAutoBlockLabel(
    AUTO_BLOCK_LABEL_PREFIXES.GMGN_INFO_LOW_MCAP_HIGH_HOLDERS,
    [marketCap, holderCount]
  );
}

function buildGmgnLowMcapExtremeVolumeLabel(snapshot = {}) {
  const marketCap = Math.round(toFiniteNumberOrNull(snapshot.mcap) || 0);
  const vol5m = Math.round(toFiniteNumberOrNull(snapshot.vol5m) || 0);
  return buildPrefixedAutoBlockLabel(
    AUTO_BLOCK_LABEL_PREFIXES.GMGN_VOLUME_LOW_MCAP_EXTREME_VOL5M,
    [marketCap, vol5m]
  );
}

function buildGmgnLowLiquiditySpamLabel(snapshot = {}) {
  const liquidityUsd = Math.round(toFiniteNumberOrNull(snapshot.liquidityUsd) || 0);
  const marketCap = Math.round(toFiniteNumberOrNull(snapshot.mcap) || 0);
  return buildPrefixedAutoBlockLabel(
    AUTO_BLOCK_LABEL_PREFIXES.GMGN_LIQUIDITY_UNDER_1K_SPAM,
    [liquidityUsd, marketCap]
  );
}

function buildGmgnBadLiquidityStatusMcapBandLabel(snapshot = {}) {
  const marketCap = Math.round(toFiniteNumberOrNull(snapshot.mcap) || 0);
  const badSignals = getBadGmgnLiquidityStatusSignals(snapshot);
  return buildPrefixedAutoBlockLabel(
    AUTO_BLOCK_LABEL_PREFIXES.GMGN_LIQUIDITY_BAD_STATUS_MCAP_BAND,
    [marketCap, `${badSignals.length}bad`, ...badSignals.slice(0, 3)]
  );
}

function buildGmgnNewNonPumpHighLaunchMcapLabel(snapshot = {}) {
  const marketCap = Math.round(toFiniteNumberOrNull(snapshot.mcap) || 0);
  const vol5m = Math.round(toFiniteNumberOrNull(snapshot.vol5m) || 0);
  return buildPrefixedAutoBlockLabel(
    AUTO_BLOCK_LABEL_PREFIXES.GMGN_NEW_NON_PUMP_HIGH_LAUNCH_MCAP,
    [marketCap, vol5m]
  );
}

function buildGmgnKlineAutoBlockLabel(analysis) {
  const runupPct = Math.round((toFiniteNumberOrNull(analysis?.runupRatio) || 0) * 100);
  return buildPrefixedAutoBlockLabel(AUTO_BLOCK_LABEL_PREFIXES.GMGN_KLINE_STAIRCASE_PUMP, [`${runupPct}%`]);
}

function buildGmgnMarketSnapshot(snapshot = {}) {
  return {
    mcap: toFiniteNumberOrNull(snapshot.mcap),
    price: toFiniteNumberOrNull(snapshot.price),
    vol1m: toFiniteNumberOrNull(snapshot.vol1m),
    vol5m: toFiniteNumberOrNull(snapshot.vol5m),
    vol1h: toFiniteNumberOrNull(snapshot.vol1h),
    vol6h: toFiniteNumberOrNull(snapshot.vol6h),
    vol24h: toFiniteNumberOrNull(snapshot.vol24h),
    liquidityUsd: toFiniteNumberOrNull(snapshot.liquidityUsd),
    priceChange1h: toFiniteNumberOrNull(snapshot.priceChange1h),
    priceChange6h: toFiniteNumberOrNull(snapshot.priceChange6h),
    priceChange24h: toFiniteNumberOrNull(snapshot.priceChange24h),
    txns1hBuys: toFiniteNumberOrNull(snapshot.txns1hBuys),
    txns1hSells: toFiniteNumberOrNull(snapshot.txns1hSells),
    txns24hBuys: toFiniteNumberOrNull(snapshot.txns24hBuys),
    txns24hSells: toFiniteNumberOrNull(snapshot.txns24hSells),
    tokenCreatedAt: snapshot.tokenCreatedAt || null,
  };
}

function firstPresentValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') {
      return value;
    }
  }
  return null;
}

function buildGmgnCatalogSnapshot(address, snapshot = {}, tokenBefore = null) {
  return {
    address,
    symbol: firstPresentValue(snapshot.symbol, tokenBefore?.symbol),
    name: firstPresentValue(snapshot.name, tokenBefore?.name),
    source: firstPresentValue(tokenBefore?.source),
    eligibilityState: firstPresentValue(tokenBefore?.eligibility_state, tokenBefore?.eligibilityState),
    suppressedReason: firstPresentValue(tokenBefore?.suppressed_reason, tokenBefore?.suppressedReason),
    pairUrl: firstPresentValue(snapshot.pairUrl, tokenBefore?.last_pair_url),
  };
}

function buildGmgnBlockEvidence(address, label, pipeline, snapshot, tokenBefore, details = {}) {
  return {
    pipeline,
    source: 'gmgn',
    catalogSnapshot: buildGmgnCatalogSnapshot(address, snapshot, tokenBefore),
    marketSnapshot: buildGmgnMarketSnapshot(snapshot),
    gmgnSnapshot: {
      rawSnapshot: snapshot || {},
      security: details.security || null,
      info: details.info || null,
      klineAnalysis: details.klineAnalysis || null,
    },
    assessment: details.assessment || {},
    ruleMatches: [{ label, pipeline }],
  };
}

async function autoBlockGmgnJunk(address, snapshot, tokenBefore, assessment, options) {
  const label = buildGmgnAutoBlockLabel(assessment);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:junk-classifier', snapshot, tokenBefore, {
      assessment,
    }),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function autoBlockGmgnSecurityRisk(address, snapshot, tokenBefore, security, options) {
  const label = buildGmgnSecurityAutoBlockLabel(security);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:security', snapshot, tokenBefore, {
      security,
    }),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function autoBlockGmgnInfoRisk(address, snapshot, tokenBefore, info, options) {
  const label = buildGmgnInfoAutoBlockLabel(info, snapshot);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:info', snapshot, tokenBefore, {
      info,
    }),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function autoBlockGmgnLowMcapExtremeVolumeRisk(address, snapshot, tokenBefore, options) {
  const label = buildGmgnLowMcapExtremeVolumeLabel(snapshot);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:low-mcap-extreme-volume', snapshot, tokenBefore),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function autoBlockGmgnLowLiquiditySpamRisk(address, snapshot, tokenBefore, options) {
  const label = buildGmgnLowLiquiditySpamLabel(snapshot);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:low-liquidity-spam', snapshot, tokenBefore),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function autoBlockGmgnBadLiquidityStatusMcapBandRisk(address, snapshot, tokenBefore, options) {
  const label = buildGmgnBadLiquidityStatusMcapBandLabel(snapshot);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:bad-liquidity-status-mcap-band', snapshot, tokenBefore),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function autoBlockGmgnNewNonPumpHighLaunchMcapRisk(address, snapshot, tokenBefore, options) {
  const label = buildGmgnNewNonPumpHighLaunchMcapLabel(snapshot);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:new-non-pump-high-launch-mcap', snapshot, tokenBefore),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function autoBlockGmgnKlineRisk(address, snapshot, tokenBefore, analysis, options) {
  const label = buildGmgnKlineAutoBlockLabel(analysis);
  await options.adminBlockedTokenModel.add({
    address,
    label,
    createdBy: null,
    evidence: buildGmgnBlockEvidence(address, label, 'gmgn-ingestion:kline', snapshot, tokenBefore, {
      klineAnalysis: analysis,
    }),
  });

  if (tokenBefore) {
    await options.tokenCatalogModel.applyEvaluationResult(address, {
      eligibilityState: 'admin-blocked',
      eligibleForMonitoring: false,
      suppressedReason: 'admin_blocked',
      nextEvaluationAt: new Date(options.now().getTime() + (10 * 365 * 24 * 60 * 60 * 1000)),
      monitorPriority: 'dormant',
      symbol: snapshot.symbol || tokenBefore.symbol || null,
      name: snapshot.name || tokenBefore.name || null,
    });
  }
}

async function applyGmgnJunkGuard(address, snapshot, tokenBefore, options, summary, manualProtected = false) {
  if (manualProtected || isManualToken(tokenBefore)) {
    return null;
  }

  const assessment = assessGmgnJunk(snapshot);
  if (!isJunkAssessment(assessment)) {
    return null;
  }

  summary.junkAssessments += 1;

  if (isHighConfidenceJunkAssessment(assessment)) {
    await autoBlockGmgnJunk(address, snapshot, tokenBefore, assessment, options);
    summary.autoBlockedJunk += 1;
    return {
      skipped: true,
      skipReason: 'gmgn-junk-auto-blocked',
      assessment,
    };
  }

  if (!tokenBefore) {
    summary.skippedJunkSuspect += 1;
    return {
      skipped: true,
      skipReason: 'gmgn-junk-suspect',
      assessment,
    };
  }

  return null;
}

async function applyGmgnSecurityRiskGuard(address, snapshot, tokenBefore, options, summary, manualProtected = false) {
  if (manualProtected || isManualToken(tokenBefore)) {
    return null;
  }

  if (isGmgnLowMcapExtremeVolumeRisk(snapshot, options.now())) {
    await autoBlockGmgnLowMcapExtremeVolumeRisk(address, snapshot, tokenBefore, options);
    summary.gmgnLowMcapExtremeVolumeAutoBlocked += 1;
    return {
      skipped: true,
      skipReason: 'gmgn-low-mcap-extreme-volume-auto-blocked',
    };
  }

  if (isNewNonPumpHighLaunchMcapRisk(address, snapshot, tokenBefore, options.now())) {
    await autoBlockGmgnNewNonPumpHighLaunchMcapRisk(address, snapshot, tokenBefore, options);
    summary.gmgnNewNonPumpHighLaunchMcapAutoBlocked += 1;
    return {
      skipped: true,
      skipReason: 'gmgn-new-non-pump-high-launch-mcap-auto-blocked',
    };
  }

  if (!shouldCheckGmgnRiskData(snapshot, options.now())) {
    return null;
  }

  const freshGuard = buildFreshPreliminaryReviewGuard(address, options);
  if (freshGuard) {
    summary.gmgnRiskReviewFreshPassed += 1;
    return freshGuard;
  }

  if (options.gmgnRiskReviewMode !== 'inline') {
    return enqueueGmgnRiskReview(address, snapshot, tokenBefore, options, summary);
  }

  if (!trySpendGmgnRiskLookupBudget(options, summary)) {
    return {
      skipped: false,
      skipReason: 'gmgn-risk-lookup-budget-exhausted',
      riskLookupBudgetSkipped: true,
    };
  }

  return runGmgnPreliminaryRiskReview(address, snapshot, tokenBefore, options, summary);
}

async function maybeEvaluateAlerts(tokenBefore, tokenAfter, options, summary) {
  const address = String(tokenAfter?.address || '').trim();
  if (!address || isBlockedToken(tokenAfter)) {
    return null;
  }
  if (tokenAfter.eligible_for_monitoring === false) {
    summary.matcherSkippedSuppressed += 1;
    return null;
  }

  const nowMs = options.now().getTime();
  if (!shouldEvaluateAlerts(address, nowMs, options)) {
    summary.matcherSkippedDebounce += 1;
    return null;
  }

  summary.matcherEvaluations += 1;
  try {
    const result = await options.alertMatcher.evaluateUpdatedToken({
      tokenBefore,
      tokenAfter,
      alertSource: 'gmgn',
    }, { now: new Date(nowMs), alertSource: 'gmgn' });
    recordMatcherResult(summary, result);
    return result;
  } catch (error) {
    summary.matcherErrors += 1;
    summary.errorMessages.push(error.message);
    return null;
  }
}

function recordMatcherResult(summary, result) {
  const emitted = Number(result?.emitted) || 0;
  const events = Array.isArray(result?.events) ? result.events : [];
  summary.matcherEmitted += emitted;
  summary.gmgn1mAlerts += events.filter((event) => String(event?.ruleKey || '').trim().toLowerCase() === 'gmgn-vol-1m').length;
}

function shouldKeepTokenInGmgnPanel(result) {
  return !result?.skipped
    && result?.tokenAfter
    && !isBlockedToken(result.tokenAfter);
}

async function applyPreCatalogGmgnGuards(address, snapshot, tokenBefore, options, summary, manualProtected, now) {
  const junkGuard = await applyGmgnJunkGuard(address, snapshot, tokenBefore, options, summary, manualProtected);
  if (junkGuard?.skipped) {
    return {
      skipped: true,
      skipReason: junkGuard.skipReason,
      junkAssessment: junkGuard.assessment,
    };
  }

  if (shouldSkipNewGmgnDiscovery(snapshot, tokenBefore, now)) {
    summary.skipped1mOnlyDiscovery = 1;
    return {
      skipped: true,
      skipReason: 'gmgn-1m-only-discovery',
    };
  }

  if (!manualProtected && isGmgnLowLiquiditySpamRisk(address, snapshot, tokenBefore, now)) {
    await autoBlockGmgnLowLiquiditySpamRisk(address, snapshot, tokenBefore, options);
    summary.gmgnLowLiquiditySpamAutoBlocked += 1;
    return {
      skipped: true,
      skipReason: 'gmgn-low-liquidity-spam-auto-blocked',
    };
  }

  if (!manualProtected && isGmgnBadLiquidityStatusMcapBandRisk(address, snapshot, tokenBefore, now)) {
    await autoBlockGmgnBadLiquidityStatusMcapBandRisk(address, snapshot, tokenBefore, options);
    summary.gmgnBadLiquidityStatusAutoBlocked += 1;
    return {
      skipped: true,
      skipReason: 'gmgn-bad-liquidity-status-auto-blocked',
    };
  }

  const securityGuard = await applyGmgnSecurityRiskGuard(address, snapshot, tokenBefore, options, summary, manualProtected);
  if (securityGuard?.skipped) {
    return {
      skipped: true,
      skipReason: securityGuard.skipReason,
      gmgnSecurity: securityGuard.security,
      gmgnInfo: securityGuard.info,
      gmgnKlineAnalysis: securityGuard.klineAnalysis,
    };
  }

  return {
    skipped: false,
    securityGuard,
  };
}

async function ingestGmgnToken(snapshot, options = {}) {
  const resolved = resolveIngestionOptions(options);
  const now = resolved.now();
  const address = normalizeAddress(snapshot.address || snapshot.tokenAddress);
  const summary = createEmptyIngestionSummary();

  const tokenBefore = await resolved.tokenCatalogModel.getByAddress(address);
  const manualProtected = await isManualTokenProtected(address, tokenBefore, resolved);
  const filledSnapshot = preserveExistingPositiveVolumeWindows(
    fillYoungTokenVolumeWindows(snapshot, { now }),
    tokenBefore
  );
  const guardResult = await applyPreCatalogGmgnGuards(
    address,
    filledSnapshot,
    tokenBefore,
    resolved,
    summary,
    manualProtected,
    now
  );
  if (guardResult.skipped) {
    return {
      summary,
      tokenBefore,
      tokenAfter: null,
      skipped: true,
      skipReason: guardResult.skipReason,
      junkAssessment: guardResult.junkAssessment,
      gmgnSecurity: guardResult.gmgnSecurity,
      gmgnInfo: guardResult.gmgnInfo,
      gmgnKlineAnalysis: guardResult.gmgnKlineAnalysis,
    };
  }
  const { securityGuard } = guardResult;

  await resolved.tokenCatalogModel.upsertToken(buildCatalogPayload(filledSnapshot, tokenBefore, { manualProtected }));
  const tokenAfter = await resolved.tokenCatalogModel.applyEvaluationResult(
    address,
    deriveGmgnEvaluation(filledSnapshot, tokenBefore, resolved)
  );

  summary.catalogUpdated = tokenAfter ? 1 : 0;
  if (tokenAfter && !isBlockedToken(tokenAfter)) {
    if (String(tokenAfter.suppressed_reason || '').trim() === GMGN_RISK_ENRICHMENT_SUPPRESSION_REASON) {
      summary.riskEnrichmentSuppressed = 1;
    }
    if (canPersistGmgnVisualBuckets(tokenAfter, filledSnapshot)) {
      if (resolved.marketBucketModel) {
        await resolved.marketBucketModel.upsertSnapshotBucket(buildMarketBucketPayload(filledSnapshot, now));
        summary.marketBucketsWritten = 1;
      }
      await resolved.volumeBucketModel.upsertSnapshotBucket(buildVolumeBucketPayload(filledSnapshot, now));
      summary.volumeBucketsWritten = 1;
    }
    if (canEvaluateGmgnAlerts(tokenBefore, tokenAfter, securityGuard)) {
      await maybeEvaluateAlerts(tokenBefore, tokenAfter, resolved, summary);
    } else {
      summary.matcherSkippedGmgnSafeguard = 1;
    }
  }

  summary.processed = 1;
  return {
    summary,
    tokenBefore,
    tokenAfter,
    snapshot: filledSnapshot,
  };
}

async function ingestGmgnTokens(tokens, options = {}) {
  const resolved = resolveIngestionOptions(options);
  const summary = createEmptyIngestionSummary();
  const results = [];
  const acceptedTokens = [];

  for (const token of Array.isArray(tokens) ? tokens : []) {
    try {
      const result = await ingestGmgnToken(token, resolved);
      mergeIngestionSummary(summary, result.summary);
      results.push(result);
      if (shouldKeepTokenInGmgnPanel(result)) {
        acceptedTokens.push(result.snapshot || token);
      }
    } catch (error) {
      summary.errors += 1;
      summary.errorMessages.push(error.message);
    }
  }

  return {
    ...summary,
    acceptedTokens,
    results,
  };
}

async function runGmgnDiscoveryIngestionCycle(options = {}) {
  const resolved = resolveIngestionOptions(options);
  const discovery = await resolved.scheduler.runOnce();
  const tokens = discovery.uniqueTokens || [];
  const ingestion = await ingestGmgnTokens(tokens, resolved);
  const panelTokens = ingestion.acceptedTokens || [];
  const canApplyPanelCycle = !discovery.skipped && !discovery.rateLimited && (discovery.errors || []).length === 0;
  const panel = canApplyPanelCycle
    ? await resolved.panelStateManager.applyPanelCycle(panelTokens, resolved)
    : null;

  return {
    discovery,
    ingestion,
    panel,
    panelSkippedReason: canApplyPanelCycle ? null : 'incomplete-gmgn-cycle',
  };
}

function createEmptyIngestionSummary() {
  return {
    processed: 0,
    catalogUpdated: 0,
    marketBucketsWritten: 0,
    volumeBucketsWritten: 0,
    matcherEvaluations: 0,
    matcherEmitted: 0,
    gmgn1mAlerts: 0,
    skipped1mOnlyDiscovery: 0,
    autoBlockedJunk: 0,
    skippedJunkSuspect: 0,
    junkAssessments: 0,
    gmgnSecurityChecks: 0,
    gmgnRiskLookupBudgetUsed: 0,
    gmgnRiskLookupBudgetSkipped: 0,
    gmgnRiskReviewQueued: 0,
    gmgnRiskReviewDeduped: 0,
    gmgnRiskReviewFreshPassed: 0,
    gmgnRiskReviewQueueErrors: 0,
    gmgnSecurityAutoBlocked: 0,
    gmgnSecurityErrors: 0,
    gmgnInfoChecks: 0,
    gmgnInfoAutoBlocked: 0,
    gmgnInfoErrors: 0,
    gmgnBadLiquidityStatusAutoBlocked: 0,
    gmgnLowLiquiditySpamAutoBlocked: 0,
    gmgnLowMcapExtremeVolumeAutoBlocked: 0,
    gmgnNewNonPumpHighLaunchMcapAutoBlocked: 0,
    gmgnKlineChecks: 0,
    gmgnKlineAutoBlocked: 0,
    gmgnKlineErrors: 0,
    matcherSkippedDebounce: 0,
    matcherSkippedSuppressed: 0,
    matcherSkippedGmgnSafeguard: 0,
    matcherErrors: 0,
    riskEnrichmentSuppressed: 0,
    errors: 0,
    errorMessages: [],
  };
}

function mergeIngestionSummary(target, source) {
  target.processed += source.processed;
  target.catalogUpdated += source.catalogUpdated;
  target.marketBucketsWritten += source.marketBucketsWritten;
  target.volumeBucketsWritten += source.volumeBucketsWritten;
  target.matcherEvaluations += source.matcherEvaluations;
  target.matcherEmitted += source.matcherEmitted;
  target.gmgn1mAlerts += source.gmgn1mAlerts;
  target.skipped1mOnlyDiscovery += source.skipped1mOnlyDiscovery;
  target.autoBlockedJunk += source.autoBlockedJunk;
  target.skippedJunkSuspect += source.skippedJunkSuspect;
  target.junkAssessments += source.junkAssessments;
  target.gmgnSecurityChecks += source.gmgnSecurityChecks;
  target.gmgnRiskLookupBudgetUsed += source.gmgnRiskLookupBudgetUsed;
  target.gmgnRiskLookupBudgetSkipped += source.gmgnRiskLookupBudgetSkipped;
  target.gmgnRiskReviewQueued += source.gmgnRiskReviewQueued;
  target.gmgnRiskReviewDeduped += source.gmgnRiskReviewDeduped;
  target.gmgnRiskReviewFreshPassed += source.gmgnRiskReviewFreshPassed;
  target.gmgnRiskReviewQueueErrors += source.gmgnRiskReviewQueueErrors;
  target.gmgnSecurityAutoBlocked += source.gmgnSecurityAutoBlocked;
  target.gmgnSecurityErrors += source.gmgnSecurityErrors;
  target.gmgnInfoChecks += source.gmgnInfoChecks;
  target.gmgnInfoAutoBlocked += source.gmgnInfoAutoBlocked;
  target.gmgnInfoErrors += source.gmgnInfoErrors;
  target.gmgnBadLiquidityStatusAutoBlocked += source.gmgnBadLiquidityStatusAutoBlocked;
  target.gmgnLowLiquiditySpamAutoBlocked += source.gmgnLowLiquiditySpamAutoBlocked;
  target.gmgnLowMcapExtremeVolumeAutoBlocked += source.gmgnLowMcapExtremeVolumeAutoBlocked;
  target.gmgnNewNonPumpHighLaunchMcapAutoBlocked += source.gmgnNewNonPumpHighLaunchMcapAutoBlocked;
  target.gmgnKlineChecks += source.gmgnKlineChecks;
  target.gmgnKlineAutoBlocked += source.gmgnKlineAutoBlocked;
  target.gmgnKlineErrors += source.gmgnKlineErrors;
  target.matcherSkippedDebounce += source.matcherSkippedDebounce;
  target.matcherSkippedSuppressed += source.matcherSkippedSuppressed;
  target.matcherSkippedGmgnSafeguard += source.matcherSkippedGmgnSafeguard;
  target.matcherErrors += source.matcherErrors;
  target.riskEnrichmentSuppressed += source.riskEnrichmentSuppressed;
  target.errors += source.errors;
  target.errorMessages.push(...source.errorMessages);
}

async function processQueuedGmgnRiskReview(task = {}, options = {}) {
  const resolved = resolveIngestionOptions({
    ...options,
    gmgnRiskReviewMode: 'inline',
  });
  const address = normalizeAddress(task.address);
  const snapshot = task.snapshot && typeof task.snapshot === 'object'
    ? task.snapshot
    : { address, chain: 'sol' };
  const summary = createEmptyIngestionSummary();
  const tokenBefore = await resolved.tokenCatalogModel.getByAddress(address);

  if (!tokenBefore || isBlockedToken(tokenBefore) || isManualToken(tokenBefore)) {
    return {
      passed: false,
      autoBlocked: false,
      summary,
    };
  }

  const guard = await runGmgnPreliminaryRiskReview(address, snapshot, tokenBefore, resolved, summary);
  if (guard?.skipped) {
    return {
      passed: false,
      autoBlocked: true,
      skipReason: guard.skipReason,
      summary,
    };
  }

  const passed = Boolean(hasCompletedGmgnPreliminaryReview(guard));
  if (passed && tokenBefore.eligible_for_monitoring !== false) {
    await maybeEvaluateAlerts(tokenBefore, tokenBefore, resolved, summary);
  }

  return {
    passed,
    autoBlocked: false,
    summary,
  };
}

function resetDefaultEvaluationState() {
  defaultEvaluationState.clear();
}

module.exports = {
  ingestGmgnToken,
  ingestGmgnTokens,
  processQueuedGmgnRiskReview,
  runGmgnDiscoveryIngestionCycle,
  __private: {
    applyGmgnJunkGuard,
    applyGmgnSecurityRiskGuard,
    analyzeGmgnKlinePattern,
    assessGmgnJunk,
    autoBlockGmgnJunk,
    autoBlockGmgnInfoRisk,
    autoBlockGmgnKlineRisk,
    autoBlockGmgnBadLiquidityStatusMcapBandRisk,
    autoBlockGmgnLowLiquiditySpamRisk,
    autoBlockGmgnSecurityRisk,
    buildGmgnAutoBlockLabel,
    buildGmgnSecurityAutoBlockLabel,
    buildGmgnJunkAssessmentInput,
    buildGmgnInfoAutoBlockLabel,
    buildGmgnKlineAutoBlockLabel,
    buildGmgnBadLiquidityStatusMcapBandLabel,
    buildGmgnLowLiquiditySpamLabel,
    createRiskLookupTokenBudget,
    enqueueGmgnRiskReview,
    buildCatalogPayload,
    isManualTokenProtected,
    buildEvaluationPayload,
    buildMarketBucketPayload,
    buildVolumeBucketPayload,
    calculateTokenAgeHours,
    canPersistGmgnVisualBuckets,
    computeSnapshotVolumeToMcapRatio,
    createEmptyIngestionSummary,
    canEvaluateGmgnAlerts,
    canPersistGmgnMarketBuckets,
    deriveGmgnEvaluation,
    DEX_CONFIRMED_ELIGIBILITY_STATES,
    GMGN_RISK_ENRICHMENT_SUPPRESSION_REASON,
    GMGN_NON_LAUNCH_GRACE_SUPPRESSION_REASON,
    GMGN_ALERT_SAFEGUARD_REASON,
    getGmgnIntervals,
    hasCompletedGmgnPreliminaryReview,
    hasDexConfirmation,
    hasKnownLaunchSuffix,
    isOneMinuteOnlyDiscovery,
    isHighConfidenceJunkAssessment,
    isJunkAssessment,
    isGmgnSecurityAutoBlockRisk,
    isGmgnInfoAutoBlockRisk,
    isGmgnBadLiquidityStatusMcapBandRisk,
    isGmgnLowLiquiditySpamRisk,
    isGmgnStaircasePumpRisk,
    mergeIngestionSummary,
    recordMatcherResult,
    resetDefaultEvaluationState,
    runGmgnPreliminaryRiskReview,
    resolveEligibilityState,
    resolveGmgnNonLaunchGraceUntil,
    getBadGmgnLiquidityStatusSignals,
    readGmgnLiquidityProtectionFields,
    resolveCatalogSource,
    resolveIngestionOptions,
    resolveMonitorPriority,
    shouldSkipNewGmgnDiscovery,
    shouldKeepTokenInGmgnPanel,
    shouldCheckGmgnRiskData,
    shouldSuppressGmgnForRiskEnrichment,
    shouldEvaluateAlerts,
    toTimestampMsOrNull,
  },
};
