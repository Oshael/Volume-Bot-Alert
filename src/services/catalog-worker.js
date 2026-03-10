const tokenCatalog = require('../models/token-catalog');
const dexscreener = require('./dexscreener');

const LOOP_INTERVAL_MS = 30000;
const BATCH_LIMIT = 20;
const SUCCESS_RECHECK_MS = 10 * 60 * 1000;
const MISS_RECHECK_MS = 20 * 60 * 1000;
const ERROR_RECHECK_MS = 5 * 60 * 1000;

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

async function evaluateToken(token) {
  const data = await dexscreener.getTokenPairs(token.address);
  const bestPair = dexscreener.getBestPair(data, token.chain || 'solana');

  if (!bestPair) {
    status.totalIneligible++;
    return tokenCatalog.applyEvaluationResult(token.address, {
      eligibilityState: 'dex-missing',
      eligibleForMonitoring: false,
      suppressedReason: 'dex_pair_missing',
      nextEvaluationAt: new Date(Date.now() + MISS_RECHECK_MS),
      lastEvaluationError: null,
      evaluationErrorCount: 0,
    });
  }

  const marketCap = Number(bestPair.marketCap || bestPair.fdv || 0);
  const isEligible = marketCap > 0;

  if (isEligible) status.totalEligible++;
  else status.totalIneligible++;

  return tokenCatalog.applyEvaluationResult(token.address, {
    eligibilityState: isEligible ? 'dex-active' : 'dex-known-no-mcap',
    eligibleForMonitoring: isEligible,
    suppressedReason: isEligible ? null : 'mcap_unavailable',
    nextEvaluationAt: new Date(Date.now() + SUCCESS_RECHECK_MS),
    lastEvaluationError: null,
    evaluationErrorCount: 0,
    symbol: bestPair.baseToken?.symbol || null,
    name: bestPair.baseToken?.name || null,
    pairAddress: bestPair.pairAddress || null,
    pairUrl: bestPair.url || null,
    imageUrl: bestPair.info?.imageUrl || null,
    twitterUrl: extractTwitterUrl(bestPair),
    mcap: marketCap || null,
    price: bestPair.priceUsd || null,
  });
}

async function runOnce() {
  if (!running) return;

  const due = await tokenCatalog.listDueForEvaluation(BATCH_LIMIT);
  status.lastRunAt = new Date().toISOString();
  status.lastProcessed = due.length;
  status.totalProcessed += due.length;

  for (const token of due) {
    try {
      await evaluateToken(token);
    } catch (err) {
      status.totalErrors++;
      await tokenCatalog.applyEvaluationResult(token.address, {
        eligibilityState: 'evaluation-error',
        eligibleForMonitoring: false,
        suppressedReason: 'evaluation_error',
        nextEvaluationAt: new Date(Date.now() + ERROR_RECHECK_MS),
        lastEvaluationError: err.message,
        evaluationErrorCount: (token.evaluation_error_count || 0) + 1,
      });
      console.error(`[CatalogWorker] Failed to evaluate ${token.address}:`, err.message);
    }
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
