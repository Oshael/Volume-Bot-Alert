const db = require('../models/db');
const {
  createRobinhoodHolderReconciliationRepository,
} = require('../models/robinhood-holder-reconciliation');
const {
  createRobinhoodTokenHolderSummaryRepository,
} = require('../models/robinhood-token-holder-summary');
const {
  createRobinhoodBlockscoutHoldersClient,
} = require('./robinhood-blockscout-holders');
const {
  createRobinhoodHolderReconciliation,
} = require('./robinhood-holder-reconciliation');
const {
  createRobinhoodHolderRequestScheduler,
} = require('./robinhood-holder-request-scheduler');

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${label} must be between ${minimum} and ${maximum}`);
    error.code = 'configuration_error';
    throw error;
  }
  return parsed;
}

function normalizeRequestOptions(input = {}) {
  const requestsPerSecond = Number(input.requestsPerSecond ?? 0.25);
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond < 0.1 || requestsPerSecond > 0.5) {
    const error = new Error('reconciliation requestsPerSecond must be between 0.1 and 0.5');
    error.code = 'configuration_error';
    throw error;
  }
  return Object.freeze({
    requestsPerSecond,
    concurrency: 1,
    maxRetries: boundedInteger(input.maxRetries, 1, 0, 1, 'reconciliation maxRetries'),
  });
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    enabled: input.enabled === true,
    intervalMs: boundedInteger(input.intervalMs, 30_000, 10_000, 900_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(
      input.maxErrorBackoffMs, 900_000, 10_000, 3_600_000, 'maxErrorBackoffMs'
    ),
    requiredMatches: boundedInteger(input.requiredMatches, 3, 2, 5, 'requiredMatches'),
    blockscoutTimeoutMs: boundedInteger(
      input.blockscoutTimeoutMs, 8_000, 1_000, 30_000, 'blockscoutTimeoutMs'
    ),
    requestOptions: normalizeRequestOptions(input.requestOptions),
  });
}

function buildRuntime(deps, options) {
  const database = deps.database || db;
  const repository = (deps.repositoryFactory || createRobinhoodHolderReconciliationRepository)({
    database,
  });
  const summaryRepository = (
    deps.summaryRepositoryFactory || createRobinhoodTokenHolderSummaryRepository
  )({ database });
  const client = (deps.clientFactory || createRobinhoodBlockscoutHoldersClient)({
    summaryTimeoutMs: options.blockscoutTimeoutMs,
  });
  const scheduler = (deps.schedulerFactory || createRobinhoodHolderRequestScheduler)(
    options.requestOptions
  );
  const observeHolderCount = async (tokenAddress) => {
    const summary = await scheduler.schedule(() => client.getTokenHolderSummary(tokenAddress));
    if (summary.available === true) {
      await summaryRepository.recordSuccess({
        tokenAddress, holderCount: summary.holderCount, observedAt: summary.observedAt,
      });
    }
    return summary;
  };
  return (deps.reconcilerFactory || createRobinhoodHolderReconciliation)({
    repository, observeHolderCount, requiredMatches: options.requiredMatches,
  });
}

function publicError(error) {
  return Object.freeze({
    code: error.code || 'holder_reconciliation_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
  });
}

function createRobinhoodHolderReconciliationWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const runtimeFactory = deps.runtimeFactory || ((options) => buildRuntime(deps, options));
  let options = normalizeOptions();
  let runtimePromise = null;
  let timer = null;
  let activeRun = null;
  let running = false;
  let onFatal = null;
  let isLiveReady = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    totalRuns: 0, totalPromoted: 0, totalMismatches: 0, totalUnavailable: 0,
    totalWaitingLive: 0,
    totalErrors: 0, consecutiveErrors: 0,
    lastResult: null, lastError: null, lastCompletedAt: null,
  };

  async function runtime() {
    runtimePromise ||= Promise.resolve(runtimeFactory(options)).catch((error) => {
      runtimePromise = null;
      throw error;
    });
    return runtimePromise;
  }

  async function halt(error) {
    running = false; status.running = false; status.halted = true;
    status.lastError = publicError(error);
    if (timer) cancelSchedule(timer);
    timer = null;
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodHolderReconciliationWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    try {
      if (isLiveReady && !isLiveReady()) {
        const result = Object.freeze({ status: 'waiting-live' });
        status.totalWaitingLive += 1; status.lastResult = result;
        status.lastError = null; status.consecutiveErrors = 0;
        return result;
      }
      const result = await (await runtime()).runOnce();
      status.lastResult = result; status.lastError = null; status.consecutiveErrors = 0;
      if (result.status === 'live') status.totalPromoted += 1;
      if (result.status === 'mismatch') status.totalMismatches += 1;
      if (result.status === 'unavailable') status.totalUnavailable += 1;
      return result;
    } catch (error) {
      status.totalErrors += 1; status.consecutiveErrors += 1; status.lastError = publicError(error);
      if (error.code === 'configuration_error' || error instanceof TypeError) await halt(error);
      else logger.warn('[RobinhoodHolderReconciliationWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false; status.lastCompletedAt = new Date().toISOString();
    }
  }

  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = execute().finally(() => { activeRun = null; });
    return activeRun;
  }

  function queueNext(delayMs) {
    if (!running || status.halted) return;
    timer = schedule(async () => {
      await runOnce();
      const delay = status.consecutiveErrors
        ? Math.min(options.maxErrorBackoffMs, options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8)))
        : options.intervalMs;
      queueNext(delay);
    }, delayMs);
    timer?.unref?.();
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    if (typeof input.isLiveReady !== 'function') {
      const error = new Error('holder reconciliation live readiness check is required');
      error.code = 'configuration_error';
      throw error;
    }
    isLiveReady = input.isLiveReady;
    status.halted = false; running = true; status.running = true; queueNext(0);
    return true;
  }

  async function stop() {
    running = false; status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodHolderReconciliationWorker();
module.exports = {
  createRobinhoodHolderReconciliationWorker,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, normalizeOptions, normalizeRequestOptions },
};
