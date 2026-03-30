const tokenCatalog = require('../models/token-catalog');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const dexscreener = require('./dexscreener');
const config = require('../../config');

const LOOP_INTERVAL_MS = 2000;
const DEX_REQUEST_BUDGET_PER_MINUTE = 300;
const DEX_TOKENS_PER_REQUEST = 30;
const MAX_TOKEN_BUDGET_PER_CYCLE = Math.max(
  DEX_TOKENS_PER_REQUEST,
  Math.floor((DEX_REQUEST_BUDGET_PER_MINUTE * LOOP_INTERVAL_MS) / 60000) * DEX_TOKENS_PER_REQUEST
);
const CONCURRENCY = config.catalogWorker.concurrency;
const DEX_BATCH_LIMIT = DEX_TOKENS_PER_REQUEST;
const DORMANT_RECHECK_MS = 30 * 60 * 1000;
const LOW_NEAR_RECHECK_MS = 15 * 1000;
const LOW_DUST_RECHECK_MS = 10 * 60 * 1000;
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
const THROTTLE_LIST_LIMIT_MULTIPLIER = 8;
const THROTTLE_LIST_LIMIT_CAP = 2500;
const LOW_NEAR_JITTER_MS = 3 * 1000;
const LOW_DUST_JITTER_MS = 60 * 1000;
const DORMANT_JITTER_MS = 2 * 60 * 1000;
const MIGRATION_GRACE_FLOOR_MS = 10 * 60 * 1000;

let timer = null;
let running = false;
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
  lastDexRequestBudget: Math.floor(MAX_TOKEN_BUDGET_PER_CYCLE / DEX_TOKENS_PER_REQUEST),
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

function formatPriorityCounts(counts = {}) {
  return ['high', 'normal', 'low', 'dormant', 'other']
    .map((key) => `${key}:${Number(counts[key]) || 0}`)
    .join(',');
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

function extractTwitterUrl(pair) {
  return pair?.info?.socials?.find((item) => item.type === 'twitter')?.url || null;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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
  return marketCap > 0 && marketCap < 15000 && isMigrationGraceActive(token, now);
}

function derivePrioritySnapshot(bestPair, token = null) {
  const marketCap = Number(bestPair?.marketCap || bestPair?.fdv || 0);
  const vol5m = toNumber(bestPair?.volume?.m5);
  const vol1h = toNumber(bestPair?.volume?.h1);
  const vol6h = toNumber(bestPair?.volume?.h6);
  const vol24h = toNumber(bestPair?.volume?.h24);
  const pchange1h = toNumber(bestPair?.priceChange?.h1);
  const pchange6h = toNumber(bestPair?.priceChange?.h6);
  const pchange24h = toNumber(bestPair?.priceChange?.h24);
  const now = Date.now();

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
      monitorPriority: 'dormant',
      nextEvaluationAt: new Date(Date.now() + addPriorityJitter(DORMANT_RECHECK_MS, DORMANT_JITTER_MS)),
      eligibleForMonitoring: false,
      eligibilityState: 'dex-known-no-mcap',
      suppressedReason: 'mcap_unavailable',
    };
  }

  if (marketCap < 30000) {
    const nextLowMs = marketCap >= 15000 || isLowDustProtectedByMigrationGrace(token, marketCap, now)
      ? addPriorityJitter(LOW_NEAR_RECHECK_MS, LOW_NEAR_JITTER_MS)
      : addPriorityJitter(LOW_DUST_RECHECK_MS, LOW_DUST_JITTER_MS);

    return {
      marketCap,
      vol5m,
      vol1h,
      vol6h,
      vol24h,
      pchange1h,
      pchange6h,
      pchange24h,
      monitorPriority: 'low',
      nextEvaluationAt: new Date(now + nextLowMs),
      eligibleForMonitoring: true,
      eligibilityState: 'dex-low',
      suppressedReason: null,
    };
  }

  if (marketCap < 100000) {
    let nextMs = NORMAL_RECHECK_MS;
    if ((pchange6h || 0) >= 200) {
      nextMs = Math.min(nextMs, NORMAL_BOOST_6H_RECHECK_MS);
    }
    if ((pchange1h || 0) >= 150) {
      nextMs = Math.min(nextMs, NORMAL_BOOST_1H_RECHECK_MS);
    }

    return {
      marketCap,
      vol5m,
      vol1h,
      vol6h,
      vol24h,
      pchange1h,
      pchange6h,
      pchange24h,
      monitorPriority: 'normal',
      nextEvaluationAt: new Date(Date.now() + nextMs),
      eligibleForMonitoring: true,
      eligibilityState: 'dex-normal',
      suppressedReason: null,
    };
  }

  let nextHighMs = HIGH_HOT_RECHECK_MS;
  if ((vol6h || 0) < 15000) {
    nextHighMs = HIGH_VERY_LOW_VOL_RECHECK_MS;
  } else if ((vol6h || 0) < 30000) {
    nextHighMs = HIGH_LOW_VOL_RECHECK_MS;
  }

  return {
    marketCap,
    vol5m,
    vol1h,
    vol6h,
    vol24h,
    pchange1h,
    pchange6h,
    pchange24h,
    monitorPriority: 'high',
    nextEvaluationAt: new Date(Date.now() + nextHighMs),
    eligibleForMonitoring: true,
    eligibilityState: 'dex-high',
    suppressedReason: null,
  };
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
  return String(token?.source || '').trim().toLowerCase() === 'user-manual'
    && !token?.last_eligible_at;
}

function getRateLimitedRetryMs(token) {
  const marketCap = Number(token?.last_mcap || 0);
  const priority = String(token?.monitor_priority || '').trim().toLowerCase();
  const lowDustProtected = isLowDustProtectedByMigrationGrace(token, marketCap);

  if (shouldFastRetryManualBootstrap(token)) {
    return RATE_LIMIT_MANUAL_RECHECK_MS;
  }

  if (priority === 'high' || marketCap >= 100000) {
    return RATE_LIMIT_HIGH_RECHECK_MS;
  }

  if (priority === 'normal' || marketCap >= 30000) {
    return RATE_LIMIT_NORMAL_RECHECK_MS;
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

  if (shouldFastRetryManualBootstrap(token)) {
    return MANUAL_BOOTSTRAP_RECHECK_MS;
  }

  return getRetryMsForPriority(token.monitor_priority);
}

function getThrottleTokenBucket(token) {
  const source = String(token?.source || '').trim().toLowerCase();
  const priority = String(token?.monitor_priority || '').trim().toLowerCase();
  const marketCap = Number(token?.last_mcap || 0);
  const lowDustProtected = isLowDustProtectedByMigrationGrace(token, marketCap);

  if (source === 'user-manual') return 'manual';
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

async function evaluateToken(token) {
  const data = await dexscreener.getTokenPairs(token.address, {
    priority: getDexPriorityHint(token),
  });
  return evaluateTokenWithData(token, data);
}

async function evaluateTokenWithData(token, data) {
  if (!data) {
    const retryMs = getDexUnavailableRetryMs(token);
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

  const bestPair = dexscreener.getBestPair(data, token.chain || 'solana');

  if (!bestPair) {
    status.totalIneligible++;
    const nextRetryMs = shouldFastRetryManualBootstrap(token)
      ? MANUAL_BOOTSTRAP_RECHECK_MS
      : DORMANT_RECHECK_MS;
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

  const snapshot = derivePrioritySnapshot(bestPair, token);
  const marketCap = snapshot.marketCap;
  const isEligible = snapshot.eligibleForMonitoring;

  if (isEligible) status.totalEligible++;
  else status.totalIneligible++;

  const updatedToken = await tokenCatalog.applyEvaluationResult(token.address, {
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
    twitterUrl: extractTwitterUrl(bestPair),
    mcap: marketCap,
    price: bestPair.priceUsd || null,
    vol5m: snapshot.vol5m,
    vol1h: snapshot.vol1h,
    vol6h: snapshot.vol6h,
    vol24h: snapshot.vol24h,
    priceChange1h: snapshot.pchange1h,
    priceChange6h: snapshot.pchange6h,
    priceChange24h: snapshot.pchange24h,
    tokenCreatedAt: toNumber(bestPair.pairCreatedAt),
  });

  const marketSnapshotPayload = {
    tokenAddress: token.address,
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

  return updatedToken;
}

function getDexPriorityHint(token) {
  const marketCap = Number(token?.last_mcap || 0);
  const priority = String(token?.monitor_priority || '').trim().toLowerCase();
  const vol6h = Number(token?.last_vol_6h || 0);
  const lowDustProtected = isLowDustProtectedByMigrationGrace(token, marketCap);

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
          await evaluateTokenWithData(token, dataByAddress.get(token.address) || null);
        } catch (err) {
          status.totalErrors++;
          await tokenCatalog.applyEvaluationResult(token.address, {
            eligibilityState: 'evaluation-error',
            eligibleForMonitoring: false,
            suppressedReason: 'evaluation_error',
            monitorPriority: 'dormant',
            nextEvaluationAt: new Date(Date.now() + ERROR_RECHECK_MS),
            lastEvaluationError: err.message,
            evaluationErrorCount: (token.evaluation_error_count || 0) + 1,
          });
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
    getDexUnavailableRetryMs,
    getDexPriorityHint,
    getGraceUntilMs,
    isLowDustProtectedByMigrationGrace,
    isMigrationGraceActive,
    getRateLimitedRetryMs,
    getThrottleTokenBucket,
    getThrottleTokenRank,
    MIGRATION_GRACE_FLOOR_MS,
    isTokenAllowedByThrottle,
    normalizeDelayMs,
    prioritizeTokensForThrottle,
  },
};
