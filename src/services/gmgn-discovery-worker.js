const config = require('../../config');
const gmgnCatalogIngestion = require('./gmgn-catalog-ingestion');

const DEFAULT_LOOP_INTERVAL_MS = 2000;

let timer = null;
let running = false;
let activeRunPromise = null;
let status = createInitialStatus();

function createInitialStatus() {
  return {
    running: false,
    inFlight: false,
    enabled: false,
    apiKeyConfigured: false,
    lastRunAt: null,
    lastCompletedAt: null,
    lastRunDurationMs: 0,
    lastScheduledDelayMs: DEFAULT_LOOP_INTERVAL_MS,
    lastSkippedReason: null,
    lastError: null,
    lastRequests: 0,
    lastRawTokens: 0,
    lastUniqueTokens: 0,
    lastRateLimited: false,
    lastBackoffRemainingMs: 0,
    lastProcessed: 0,
    lastCatalogUpdated: 0,
    lastVolumeBucketsWritten: 0,
    lastSkipped1mOnlyDiscovery: 0,
    lastAutoBlockedJunk: 0,
    lastSkippedJunkSuspect: 0,
    lastJunkAssessments: 0,
    lastMatcherEvaluations: 0,
    lastMatcherEmitted: 0,
    lastMatcherSkippedGmgnSafeguard: 0,
    lastGmgn1mAlerts: 0,
    lastMatcherErrors: 0,
    lastPanelSeenCount: 0,
    lastPanelStaleCount: 0,
    lastPanelHandoffCount: 0,
    lastPanelSkippedReason: null,
    totalRuns: 0,
    totalSuccessfulRuns: 0,
    totalErrors: 0,
    totalProcessed: 0,
    totalCatalogUpdated: 0,
    totalVolumeBucketsWritten: 0,
    totalSkipped1mOnlyDiscovery: 0,
    totalAutoBlockedJunk: 0,
    totalSkippedJunkSuspect: 0,
    totalJunkAssessments: 0,
    totalMatcherEvaluations: 0,
    totalMatcherEmitted: 0,
    totalMatcherSkippedGmgnSafeguard: 0,
    totalGmgn1mAlerts: 0,
    totalPanelHandoffs: 0,
  };
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true' || value === '1';
}

function normalizeDelayMs(value, fallback = DEFAULT_LOOP_INTERVAL_MS) {
  const delayMs = Number(value);
  if (!Number.isFinite(delayMs)) {
    return fallback;
  }
  return Math.max(250, Math.round(delayMs));
}

function normalizeOptions(options = {}) {
  return {
    enabled: normalizeBoolean(options.enabled, false),
    intervalMs: normalizeDelayMs(options.intervalMs, DEFAULT_LOOP_INTERVAL_MS),
    apiKeyConfigured: Boolean(options.apiKeyConfigured),
    schedulerOptions: options.schedulerOptions || {},
    ingestionOptions: options.ingestionOptions || {},
  };
}

function getDefaultOptions() {
  return normalizeOptions(config.gmgnDiscoveryWorker || {});
}

function normalizeErrorMessage(error) {
  const message = String(error?.message || error || '').trim();
  return message ? message.slice(0, 1000) : 'Unknown GMGN discovery worker error';
}

function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

function toCount(value) {
  return Number(value) || 0;
}

function buildRunCounters(result) {
  const discovery = result?.discovery || {};
  const ingestion = result?.ingestion || {};
  const panel = result?.panel || {};

  return {
    lastSkippedReason: discovery.skipped ? discovery.reason || 'gmgn-skipped' : null,
    lastRequests: toCount(discovery.requests),
    lastRawTokens: countItems(discovery.tokens),
    lastUniqueTokens: countItems(discovery.uniqueTokens),
    lastRateLimited: Boolean(discovery.rateLimited),
    lastBackoffRemainingMs: toCount(discovery.backoffRemainingMs),
    lastProcessed: toCount(ingestion.processed),
    lastCatalogUpdated: toCount(ingestion.catalogUpdated),
    lastVolumeBucketsWritten: toCount(ingestion.volumeBucketsWritten),
    lastSkipped1mOnlyDiscovery: toCount(ingestion.skipped1mOnlyDiscovery),
    lastAutoBlockedJunk: toCount(ingestion.autoBlockedJunk),
    lastSkippedJunkSuspect: toCount(ingestion.skippedJunkSuspect),
    lastJunkAssessments: toCount(ingestion.junkAssessments),
    lastMatcherEvaluations: toCount(ingestion.matcherEvaluations),
    lastMatcherEmitted: toCount(ingestion.matcherEmitted),
    lastMatcherSkippedGmgnSafeguard: toCount(ingestion.matcherSkippedGmgnSafeguard),
    lastGmgn1mAlerts: toCount(ingestion.gmgn1mAlerts),
    lastMatcherErrors: toCount(ingestion.matcherErrors),
    lastPanelSeenCount: toCount(panel.seenCount),
    lastPanelStaleCount: toCount(panel.staleCount),
    lastPanelHandoffCount: toCount(panel.handoffCount),
    lastPanelSkippedReason: result?.panelSkippedReason || null,
  };
}

function addTotalsFromCounters(counters) {
  status.totalProcessed += counters.lastProcessed;
  status.totalCatalogUpdated += counters.lastCatalogUpdated;
  status.totalVolumeBucketsWritten += counters.lastVolumeBucketsWritten;
  status.totalSkipped1mOnlyDiscovery += counters.lastSkipped1mOnlyDiscovery;
  status.totalAutoBlockedJunk += counters.lastAutoBlockedJunk;
  status.totalSkippedJunkSuspect += counters.lastSkippedJunkSuspect;
  status.totalJunkAssessments += counters.lastJunkAssessments;
  status.totalMatcherEvaluations += counters.lastMatcherEvaluations;
  status.totalMatcherEmitted += counters.lastMatcherEmitted;
  status.totalMatcherSkippedGmgnSafeguard += counters.lastMatcherSkippedGmgnSafeguard;
  status.totalGmgn1mAlerts += counters.lastGmgn1mAlerts;
  status.totalPanelHandoffs += counters.lastPanelHandoffCount;
}

function updateStatusFromResult(result) {
  const counters = buildRunCounters(result);
  Object.assign(status, counters);
  addTotalsFromCounters(counters);
}

function computeNextDelayMs(intervalMs, startedAtMs) {
  return Math.max(0, intervalMs - (Date.now() - startedAtMs));
}

function schedule(options = {}) {
  if (!running) return;
  const normalized = normalizeOptions(options);
  timer = setTimeout(async () => {
    try {
      await runOnce(normalized, { ifRunning: 'join' });
    } catch (err) {
      console.error('[GmgnDiscoveryWorker] Scheduled run failed:', err.message);
    } finally {
      schedule(normalized);
    }
  }, status.lastScheduledDelayMs);
}

async function runOnce(options = {}, meta = {}, deps = {}) {
  const normalized = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();

  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('GMGN discovery worker already has an active run');
  }

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    status.inFlight = true;
    status.enabled = normalized.enabled;
    status.apiKeyConfigured = Boolean(normalized.apiKeyConfigured);
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastError = null;
    status.lastSkippedReason = null;
    status.totalRuns += 1;

    try {
      if (!normalized.enabled) {
        status.lastSkippedReason = 'disabled';
        return { skipped: true, reason: 'disabled' };
      }

      const service = deps.gmgnCatalogIngestion || gmgnCatalogIngestion;
      const result = await service.runGmgnDiscoveryIngestionCycle({
        ...normalized.ingestionOptions,
        schedulerOptions: normalized.schedulerOptions,
      });
      updateStatusFromResult(result);
      status.totalSuccessfulRuns += 1;
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = normalizeErrorMessage(error);
      throw error;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastScheduledDelayMs = computeNextDelayMs(normalized.intervalMs, startedAtMs);
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

function start(options = getDefaultOptions()) {
  if (running) return;
  const normalized = normalizeOptions(options);
  status.enabled = normalized.enabled;
  status.apiKeyConfigured = Boolean(normalized.apiKeyConfigured);
  status.lastScheduledDelayMs = normalized.intervalMs;

  if (!normalized.enabled) {
    status.running = false;
    return;
  }

  running = true;
  status.running = true;
  schedule(normalized);
  console.log('[GmgnDiscoveryWorker] Started');
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

function resetStatus() {
  stop();
  activeRunPromise = null;
  status = createInitialStatus();
}

module.exports = {
  DEFAULT_LOOP_INTERVAL_MS,
  getStatus,
  runOnce,
  start,
  stop,
  __private: {
    computeNextDelayMs,
    buildRunCounters,
    normalizeOptions,
    resetStatus,
    updateStatusFromResult,
  },
};
