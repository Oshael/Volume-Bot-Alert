const { createRobinhoodAlertPublicationBatch } = require('./robinhood-alert-publication-batch');

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ERROR_BACKOFF_MS = 5 * 60_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled === true,
    intervalMs: boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 5000, 60 * 60_000),
    maxErrorBackoffMs: boundedInteger(
      options.maxErrorBackoffMs,
      DEFAULT_MAX_ERROR_BACKOFF_MS,
      5000,
      60 * 60_000
    ),
    signalConfig: options.signalConfig || {},
    candidateLimit: boundedInteger(options.candidateLimit, 1000, 1, 5000),
    statementTimeoutMs: boundedInteger(options.statementTimeoutMs, 10_000, 1000, 60_000),
    rolloutProvider: typeof options.rolloutProvider === 'function'
      ? options.rolloutProvider
      : () => ({ alertsRequested: false, publishable: false }),
  };
}

function compactPublicationTelemetry(publication) {
  if (!publication) return null;
  const delivery = publication.delivery || {};
  return {
    mode: publication.mode === 'shadow' ? 'shadow' : 'delivery',
    evaluatedProfiles: Number(publication.evaluatedProfiles) || 0,
    matchedProfiles: Number(publication.matchedProfiles) || 0,
    evaluatedCustomRules: Number(publication.evaluatedCustomRules) || 0,
    matchedCustomRules: Number(publication.matchedCustomRules) || 0,
    intents: Number(publication.intents) || 0,
    deliveryStatus: delivery.status || null,
    deliveryReason: delivery.reason || null,
    attempted: Number(delivery.attempted) || 0,
    persisted: Number(delivery.persisted) || 0,
    duplicates: Number(delivery.duplicates) || 0,
    notified: Number(delivery.notified) || 0,
    publishErrors: Number(delivery.publishErrors) || 0,
    errors: Number(delivery.errors) || 0,
    lastError: delivery.lastError ? String(delivery.lastError).slice(0, 240) : null,
  };
}

function buildRobinhoodCatalogStagingTelemetry(workerStatus = {}, now = Date.now) {
  const summary = workerStatus.lastSummary || null;
  return Object.freeze({
    version: 1,
    capturedAt: new Date(now()).toISOString(),
    running: workerStatus.running === true,
    inFlight: workerStatus.inFlight === true,
    totalRuns: Number(workerStatus.totalRuns) || 0,
    totalErrors: Number(workerStatus.totalErrors) || 0,
    consecutiveErrors: Number(workerStatus.consecutiveErrors) || 0,
    lastRunAt: workerStatus.lastRunAt || null,
    lastCompletedAt: workerStatus.lastCompletedAt || null,
    lastDurationMs: Number(workerStatus.lastDurationMs) || 0,
    lastError: workerStatus.lastError || null,
    lastSummary: summary ? {
      status: summary.status || null,
      reason: summary.reason || null,
      queried: Number(summary.queried) || 0,
      expectedSignals: Number(summary.expectedSignals) || 0,
      staged: Number(summary.staged) || 0,
      suppressed: Number(summary.suppressed) || 0,
      candidateLimitReached: summary.candidateLimitReached === true,
      publication: compactPublicationTelemetry(summary.publication),
    } : null,
  });
}

function createRobinhoodCatalogStagingWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const batch = deps.batch || createRobinhoodAlertPublicationBatch(deps.batchOptions);
  let options = normalizeOptions();
  let timer = null;
  let running = false;
  let activeRunPromise = null;
  const status = {
    enabled: false,
    running: false,
    inFlight: false,
    lastRunAt: null,
    lastCompletedAt: null,
    lastDurationMs: 0,
    lastSummary: null,
    lastError: null,
    consecutiveErrors: 0,
    totalErrors: 0,
    totalRuns: 0,
  };

  async function runOnce() {
    if (activeRunPromise) return activeRunPromise;
    activeRunPromise = (async () => {
      const startedAt = Date.now();
      status.inFlight = true;
      status.lastRunAt = new Date().toISOString();
      status.totalRuns += 1;
      try {
        const rollout = await options.rolloutProvider();
        if (!rollout || typeof rollout !== 'object' || Array.isArray(rollout)) {
          throw new TypeError('Robinhood staging rollout provider must return an object');
        }
        const summary = await batch.runOnce({
          signalConfig: options.signalConfig,
          candidateLimit: options.candidateLimit,
          statementTimeoutMs: options.statementTimeoutMs,
          alertsRequested: rollout.alertsRequested === true,
          publishable: rollout.publishable === true,
        });
        status.lastSummary = summary;
        status.lastError = null;
        status.consecutiveErrors = 0;
        status.lastCompletedAt = new Date().toISOString();
        return summary;
      } catch (error) {
        status.totalErrors += 1;
        status.consecutiveErrors += 1;
        status.lastError = String(error?.message || error).slice(0, 500);
        throw error;
      } finally {
        status.lastDurationMs = Math.max(0, Date.now() - startedAt);
        status.inFlight = false;
        activeRunPromise = null;
      }
    })();
    return activeRunPromise;
  }

  function nextDelayMs() {
    if (!status.consecutiveErrors) return options.intervalMs;
    return Math.min(
      options.maxErrorBackoffMs,
      options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8))
    );
  }

  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try {
        await runOnce();
      } catch (error) {
        logger.error(`[RobinhoodCatalogStagingWorker] ${error.message}`);
      } finally {
        queueNext(nextDelayMs());
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    running = true;
    status.running = true;
    queueNext(0);
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRunPromise) await activeRunPromise.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodCatalogStagingWorker();

module.exports = {
  buildRobinhoodCatalogStagingTelemetry,
  createRobinhoodCatalogStagingWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { normalizeOptions },
};
