const db = require('../models/db');
const {
  createRobinhoodHolderBootstrapRepository,
} = require('../models/robinhood-holder-bootstrap');
const {
  createConfiguredRobinhoodHolderBackfillExecutor,
} = require('./robinhood-holder-backfill-executor');

const REPLAY_STATUSES = new Set([
  'idle', 'committed', 'drift-suspected', 'drift-unverified', 'drifted', 'resyncing',
]);

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${label} must be between ${minimum} and ${maximum}`);
    error.code = 'configuration_error';
    throw error;
  }
  return parsed;
}

function admissionCutoff(value, required) {
  if (value == null) {
    if (!required) return null;
    const error = new Error('holder backfill admittedAfter is required and must be a timestamp');
    error.code = 'configuration_error';
    throw error;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    const error = new Error('holder backfill admittedAfter is required and must be a timestamp');
    error.code = 'configuration_error';
    throw error;
  }
  return parsed.toISOString();
}

function normalizeOptions(input = {}) {
  const enabled = input.enabled === true;
  return Object.freeze({
    enabled,
    admittedAfter: admissionCutoff(input.admittedAfter, enabled),
    intervalMs: boundedInteger(input.intervalMs, 500, 100, 300_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(
      input.maxErrorBackoffMs, 30_000, 1000, 300_000, 'maxErrorBackoffMs'
    ),
    seedLimit: boundedInteger(input.seedLimit, 100, 1, 1000, 'seedLimit'),
    rangeSize: boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize'),
    confirmations: boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations'),
  });
}

function buildRuntime(deps = {}) {
  const database = deps.database || db;
  const bootstrap = deps.bootstrap
    || (deps.bootstrapFactory || createRobinhoodHolderBootstrapRepository)({ database });
  const executor = deps.executor
    || (deps.executorFactory || createConfiguredRobinhoodHolderBackfillExecutor)({
      database, env: deps.env || process.env,
    });
  return Object.freeze({ bootstrap, executor });
}

function publicError(error) {
  return Object.freeze({
    code: error.code || 'holder_backfill_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
  });
}

function normalizeResult(seeded, replay) {
  if (!Array.isArray(seeded) || !REPLAY_STATUSES.has(replay?.status)) {
    const error = new Error(`unexpected holder backfill result: ${replay?.status}`);
    error.code = 'holder_backfill_contract_error';
    throw error;
  }
  return Object.freeze({
    status: seeded.length || replay.status !== 'idle' ? 'completed' : 'idle',
    seededTokens: seeded.length,
    replayStatus: replay.status,
    tokenAddress: replay.tokenAddress || null,
    committedRanges: replay.status === 'committed' ? 1 : 0,
    driftSuspicions: replay.status === 'drift-suspected' ? 1 : 0,
    driftedTokens: replay.status === 'drifted' ? 1 : 0,
    resyncingTokens: replay.status === 'resyncing' ? 1 : 0,
    atBarrier: replay.atBarrier === true,
    safeHead: replay.safeHead ?? null,
    ...(replay.reason ? { reason: replay.reason } : {}),
  });
}

function createRobinhoodHolderBackfillWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const runtimeFactory = deps.runtimeFactory || (() => buildRuntime(deps));
  let options = normalizeOptions();
  let runtimePromise = null;
  let timer = null;
  let activeRunPromise = null;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    lastResult: null, lastError: null, totalRuns: 0, totalErrors: 0,
    consecutiveErrors: 0, totalSeededTokens: 0, totalCommittedRanges: 0,
    totalDriftSuspicions: 0, totalDriftedTokens: 0,
    totalResyncingTokens: 0, lastCompletedAt: null,
  };

  async function getRuntime() {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve(runtimeFactory()).catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  }

  async function halt(error) {
    running = false;
    status.running = false;
    status.halted = true;
    status.lastError = publicError(error);
    if (timer) cancelSchedule(timer);
    timer = null;
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodHolderBackfillWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const runtime = await getRuntime();
      const seeded = await runtime.bootstrap.seedNewTokens({
        admittedAfter: options.admittedAfter, limit: options.seedLimit,
      });
      const replay = await runtime.executor.runOnce({
        rangeSize: options.rangeSize, confirmations: options.confirmations,
      });
      const result = normalizeResult(seeded, replay);
      status.lastResult = result;
      status.lastError = null;
      status.consecutiveErrors = 0;
      status.totalSeededTokens += result.seededTokens;
      status.totalCommittedRanges += result.committedRanges;
      status.totalDriftSuspicions += result.driftSuspicions;
      status.totalDriftedTokens += result.driftedTokens;
      status.totalResyncingTokens += result.resyncingTokens;
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.consecutiveErrors += 1;
      status.lastError = publicError(error);
      if (error.code === 'configuration_error'
          || error.code === 'holder_backfill_contract_error') await halt(error);
      else logger.warn('[RobinhoodHolderBackfillWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date().toISOString();
    }
  }

  async function runOnce() {
    if (activeRunPromise) return activeRunPromise;
    activeRunPromise = execute().finally(() => { activeRunPromise = null; });
    return activeRunPromise;
  }

  function queueNext(delayMs) {
    if (!running || status.halted) return;
    timer = schedule(async () => {
      await runOnce();
      const delay = status.consecutiveErrors
        ? Math.min(
            options.maxErrorBackoffMs,
            options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8))
          )
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
    status.halted = false;
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

const worker = createRobinhoodHolderBackfillWorker();

module.exports = {
  createRobinhoodHolderBackfillWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { buildRuntime, normalizeOptions, normalizeResult },
};
