const config = require('../../config');
const gmgnClient = require('./gmgn-client');
const gmgnClaimSignalAlert = require('./gmgn-claim-signal-alert');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_SIGNAL_TYPES = [17, 18];

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
    lastScheduledDelayMs: DEFAULT_INTERVAL_MS,
    lastError: null,
    lastRequests: 0,
    lastSignals: 0,
    lastBaselined: 0,
    lastTriggered: 0,
    lastDeduped: 0,
    lastSuppressed: 0,
    totalRuns: 0,
    totalSuccessfulRuns: 0,
    totalErrors: 0,
    totalRequests: 0,
    totalSignals: 0,
    totalBaselined: 0,
    totalTriggered: 0,
    totalDeduped: 0,
    totalSuppressed: 0,
  };
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true' || value === '1';
}

function normalizeDelayMs(value, fallback = DEFAULT_INTERVAL_MS) {
  const delayMs = Number(value);
  if (!Number.isFinite(delayMs)) {
    return fallback;
  }
  return Math.max(5000, Math.round(delayMs));
}

function normalizeSignalTypes(value) {
  const input = Array.isArray(value) ? value : DEFAULT_SIGNAL_TYPES;
  const normalized = input
    .map((item) => gmgnClient.__private.normalizeSignalType(item))
    .filter((item) => item === 17 || item === 18);
  return [...new Set(normalized)].length ? [...new Set(normalized)] : DEFAULT_SIGNAL_TYPES;
}

function normalizeOptions(options = {}) {
  return {
    enabled: normalizeBoolean(options.enabled, false),
    intervalMs: normalizeDelayMs(options.intervalMs, DEFAULT_INTERVAL_MS),
    apiKeyConfigured: Boolean(options.apiKeyConfigured),
    chain: gmgnClient.__private.normalizeChain(options.chain || 'sol'),
    signalTypes: normalizeSignalTypes(options.signalTypes),
    maxAlertsPerToken: Math.max(1, Math.trunc(Number(options.maxAlertsPerToken) || 2)),
    baselineOnEmptyState: normalizeBoolean(options.baselineOnEmptyState, true),
    client: options.client || gmgnClient.createGmgnClient(options.clientOptions || {}),
    alertService: options.alertService || gmgnClaimSignalAlert,
  };
}

function getDefaultOptions() {
  return normalizeOptions(config.gmgnClaimSignalWorker || {});
}

function normalizeErrorMessage(error) {
  const message = String(error?.message || error || '').trim();
  return message ? message.slice(0, 1000) : 'Unknown GMGN claim signal worker error';
}

function updateStatusFromSummary(summary) {
  Object.assign(status, {
    lastRequests: summary.requests,
    lastSignals: summary.signals,
    lastBaselined: summary.baselined,
    lastTriggered: summary.triggered,
    lastDeduped: summary.deduped,
    lastSuppressed: summary.suppressed,
  });
  status.totalRequests += summary.requests;
  status.totalSignals += summary.signals;
  status.totalBaselined += summary.baselined;
  status.totalTriggered += summary.triggered;
  status.totalDeduped += summary.deduped;
  status.totalSuppressed += summary.suppressed;
}

function computeNextDelayMs(intervalMs, startedAtMs) {
  return Math.max(0, intervalMs - (Date.now() - startedAtMs));
}

async function runSignalType(signalType, options, summary, baselineMode) {
  summary.requests += 1;
  const signals = await options.client.fetchMarketSignal({
    chain: options.chain,
    signalType,
  });
  summary.signals += signals.length;

  for (const signal of signals) {
    const recorder = baselineMode
      ? options.alertService.recordClaimSignalBaseline
      : options.alertService.recordClaimSignal;
    const result = await recorder.call(options.alertService, signal, {
      maxAlertsPerToken: options.maxAlertsPerToken,
    });
    if (result.action === 'baselined') {
      summary.baselined += 1;
    } else if (result.action === 'triggered') {
      summary.triggered += 1;
    } else if (result.action === 'suppressed') {
      summary.suppressed += 1;
    } else {
      summary.deduped += 1;
    }
  }
}

async function runOnce(options = {}, meta = {}) {
  const normalized = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();

  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('GMGN claim signal worker already has an active run');
  }

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    const summary = { requests: 0, signals: 0, baselined: 0, triggered: 0, deduped: 0, suppressed: 0 };
    status.inFlight = true;
    status.enabled = normalized.enabled;
    status.apiKeyConfigured = Boolean(normalized.apiKeyConfigured);
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastError = null;
    status.totalRuns += 1;

    try {
      if (!normalized.enabled) {
        return { skipped: true, reason: 'disabled', summary };
      }

      const baselineMode = normalized.baselineOnEmptyState
        && typeof normalized.alertService.hasBaselineCompleted === 'function'
        && !(await normalized.alertService.hasBaselineCompleted());
      for (const signalType of normalized.signalTypes) {
        await runSignalType(signalType, normalized, summary, baselineMode);
      }
      if (baselineMode && typeof normalized.alertService.markBaselineCompleted === 'function') {
        await normalized.alertService.markBaselineCompleted();
      }
      updateStatusFromSummary(summary);
      status.totalSuccessfulRuns += 1;
      return { skipped: false, summary };
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

function schedule(options = {}) {
  if (!running) return;
  const normalized = normalizeOptions(options);
  timer = setTimeout(async () => {
    try {
      await runOnce(normalized, { ifRunning: 'join' });
    } catch (err) {
      console.error('[GmgnClaimSignalWorker] Scheduled run failed:', err.message);
    } finally {
      schedule(normalized);
    }
  }, status.lastScheduledDelayMs);
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
  console.log('[GmgnClaimSignalWorker] Started');
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
  getStatus,
  runOnce,
  start,
  stop,
  __private: {
    normalizeOptions,
    resetStatus,
  },
};
