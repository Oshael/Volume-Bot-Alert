const tokenCatalog = require('../models/token-catalog');
const tokenMarketSnapshot = require('../models/token-market-snapshot');
const dexscreener = require('./dexscreener');

const LOOP_INTERVAL_MS = 5000;
const BATCH_LIMIT = 60;
const CONCURRENCY = 8;
const DORMANT_RECHECK_MS = 30 * 60 * 1000;
const LOW_NEAR_RECHECK_MS = 3 * 60 * 1000;
const LOW_DUST_RECHECK_MS = 10 * 60 * 1000;
const NORMAL_RECHECK_MS = 60 * 1000;
const NORMAL_BOOST_6H_RECHECK_MS = 40 * 1000;
const NORMAL_BOOST_1H_RECHECK_MS = 20 * 1000;
const HIGH_HOT_RECHECK_MS = 15 * 1000;
const HIGH_WARM_RECHECK_MS = 30 * 1000;
const HIGH_VERY_LOW_VOL_RECHECK_MS = 60 * 1000;
const HIGH_LOW_VOL_RECHECK_MS = HIGH_WARM_RECHECK_MS;
const ERROR_RECHECK_MS = 60 * 1000;
const MANUAL_BOOTSTRAP_RECHECK_MS = 5 * 1000;

let timer = null;
let running = false;
let status = {
  running: false,
  lastRunAt: null,
  lastProcessed: 0,
  totalProcessed: 0,
  totalEligible: 0,
  totalIneligible: 0,
  totalErrors: 0,
};

function extractTwitterUrl(pair) {
  return pair?.info?.socials?.find((item) => item.type === 'twitter')?.url || null;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function derivePrioritySnapshot(bestPair) {
  const marketCap = Number(bestPair?.marketCap || bestPair?.fdv || 0);
  const vol5m = toNumber(bestPair?.volume?.m5);
  const vol1h = toNumber(bestPair?.volume?.h1);
  const vol6h = toNumber(bestPair?.volume?.h6);
  const vol24h = toNumber(bestPair?.volume?.h24);
  const pchange1h = toNumber(bestPair?.priceChange?.h1);
  const pchange6h = toNumber(bestPair?.priceChange?.h6);
  const pchange24h = toNumber(bestPair?.priceChange?.h24);

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
      nextEvaluationAt: new Date(Date.now() + DORMANT_RECHECK_MS),
      eligibleForMonitoring: false,
      eligibilityState: 'dex-known-no-mcap',
      suppressedReason: 'mcap_unavailable',
    };
  }

  if (marketCap < 30000) {
    const nextLowMs = marketCap >= 15000
      ? LOW_NEAR_RECHECK_MS
      : LOW_DUST_RECHECK_MS;

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
      nextEvaluationAt: new Date(Date.now() + nextLowMs),
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

async function evaluateToken(token) {
  const data = await dexscreener.getTokenPairs(token.address, {
    priority: getDexPriorityHint(token),
  });
  if (!data) {
    const retryMs = shouldFastRetryManualBootstrap(token)
      ? MANUAL_BOOTSTRAP_RECHECK_MS
      : getRetryMsForPriority(token.monitor_priority);
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

  const snapshot = derivePrioritySnapshot(bestPair);
  const marketCap = snapshot.marketCap;
  const isEligible = snapshot.eligibleForMonitoring;

  if (isEligible) status.totalEligible++;
  else status.totalIneligible++;

  await tokenMarketSnapshot.insertSnapshot({
    tokenAddress: token.address,
    mcap: marketCap,
    price: bestPair.priceUsd || null,
    vol5m: snapshot.vol5m,
    vol1h: snapshot.vol1h,
    vol6h: snapshot.vol6h,
    vol24h: snapshot.vol24h,
    source: 'dexscreener',
  });

  return tokenCatalog.applyEvaluationResult(token.address, {
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
}

function getDexPriorityHint(token) {
  const marketCap = Number(token?.last_mcap || 0);
  const priority = String(token?.monitor_priority || '').trim().toLowerCase();
  const vol6h = Number(token?.last_vol_6h || 0);

  if (priority === 'high' || marketCap >= 100000) {
    if (vol6h < 15000) return 'high-cold';
    if (vol6h < 30000) return 'high-warm';
    return 'high-hot';
  }

  if (priority === 'normal' || marketCap >= 30000) {
    return 'normal';
  }

  if (marketCap >= 15000) {
    return 'low-near';
  }

  if (marketCap > 0) {
    return 'low-dust';
  }

  return 'dormant';
}

async function runOnce() {
  if (!running) return;

  const due = await tokenCatalog.listDueForEvaluation(BATCH_LIMIT);
  status.lastRunAt = new Date().toISOString();
  status.lastProcessed = due.length;
  status.totalProcessed += due.length;

  for (let index = 0; index < due.length; index += CONCURRENCY) {
    const batch = due.slice(index, index + CONCURRENCY);
    await Promise.all(batch.map(async (token) => {
      try {
        await evaluateToken(token);
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

function schedule() {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce();
    } finally {
      schedule();
    }
  }, LOOP_INTERVAL_MS);
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

module.exports = { start, stop, getStatus, runOnce };
