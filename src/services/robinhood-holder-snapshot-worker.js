const db = require('../models/db');
const {
  createRobinhoodTokenHolderSummaryRepository,
} = require('../models/robinhood-token-holder-summary');

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${label} must be between ${minimum} and ${maximum}`);
    error.code = 'configuration_error';
    throw error;
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    enabled: input.enabled === true,
    intervalMs: boundedInteger(input.intervalMs, 60_000, 10_000, 3_600_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(
      input.maxErrorBackoffMs, 300_000, 10_000, 3_600_000, 'maxErrorBackoffMs'
    ),
    batchSize: boundedInteger(input.batchSize, 500, 1, 5000, 'batchSize'),
  });
}

function publicError(error) {
  return Object.freeze({
    code: error.code || 'holder_snapshot_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
  });
}

function createRobinhoodHolderSnapshotWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  const repository = deps.repository
    || (deps.repositoryFactory || createRobinhoodTokenHolderSummaryRepository)({
      database: deps.database || db,
    });
  let options = normalizeOptions();
  let timer = null;
  let activeRun = null;
  let running = false;
  let isLiveReady = null;
  const status = {
    enabled: false, running: false, inFlight: false,
    totalRuns: 0, totalSaved: 0, totalErrors: 0, consecutiveErrors: 0,
    totalWaitingLive: 0,
    lastResult: null, lastError: null, lastCompletedAt: null,
  };

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      if (isLiveReady && !isLiveReady()) {
        const result = Object.freeze({ status: 'waiting-live', savedCount: 0 });
        status.lastResult = result;
        status.totalWaitingLive += 1;
        status.lastError = null;
        status.consecutiveErrors = 0;
        return result;
      }
      const result = await repository.syncLiveDailySnapshots({
        asOf: new Date(now()).toISOString(), limit: options.batchSize,
      });
      status.lastResult = result;
      status.totalSaved += result.savedCount;
      status.lastError = null;
      status.consecutiveErrors = 0;
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.consecutiveErrors += 1;
      status.lastError = publicError(error);
      logger.warn('[RobinhoodHolderSnapshotWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date(now()).toISOString();
    }
  }

  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = execute().finally(() => { activeRun = null; });
    return activeRun;
  }

  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      await runOnce();
      const delay = status.consecutiveErrors
        ? Math.min(options.maxErrorBackoffMs,
          options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8)))
        : options.intervalMs;
      queueNext(delay);
    }, delayMs);
    timer?.unref?.();
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    if (typeof input.isLiveReady !== 'function') {
      const error = new Error('holder snapshot live readiness check is required');
      error.code = 'configuration_error';
      throw error;
    }
    isLiveReady = input.isLiveReady;
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
    if (activeRun) await activeRun.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodHolderSnapshotWorker();

module.exports = {
  createRobinhoodHolderSnapshotWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { normalizeOptions },
};
