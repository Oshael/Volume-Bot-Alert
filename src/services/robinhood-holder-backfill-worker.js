const db = require('../models/db');
const {
  createRobinhoodHolderBootstrapRepository,
} = require('../models/robinhood-holder-bootstrap');
const {
  createConfiguredRobinhoodHolderBackfillExecutor,
} = require('./robinhood-holder-backfill-executor');

const REPLAY_STATUSES = new Set([
  'idle', 'committed', 'drift-suspected', 'drift-unverified', 'drifted', 'resyncing',
  'superseded',
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
    maxInitialGapBlocks: boundedInteger(
      input.maxInitialGapBlocks, 20_000, 1, 100_000_000, 'maxInitialGapBlocks'
    ),
    concurrency: boundedInteger(input.concurrency, 1, 1, 8, 'concurrency'),
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

function normalizeResult(seeded, replays) {
  if (!Array.isArray(seeded) || !Array.isArray(replays) || !replays.length
      || replays.some((replay) => !REPLAY_STATUSES.has(replay?.status))) {
    const statuses = Array.isArray(replays)
      ? replays.map((replay) => replay?.status).join(',') : 'missing';
    const error = new Error(`unexpected holder backfill result: ${statuses}`);
    error.code = 'holder_backfill_contract_error';
    throw error;
  }
  const active = replays.filter((replay) => replay.status !== 'idle');
  const primary = active[0] || replays[0];
  return Object.freeze({
    status: seeded.length || active.length ? 'completed' : 'idle',
    seededTokens: seeded.length,
    replayStatus: primary.status,
    tokenAddress: primary.tokenAddress || null,
    committedRanges: replays.filter(({ status }) => status === 'committed').length,
    driftSuspicions: replays.filter(({ status }) => status === 'drift-suspected').length,
    driftedTokens: replays.filter(({ status }) => status === 'drifted').length,
    resyncingTokens: replays.filter(({ status }) => status === 'resyncing').length,
    supersededTokens: replays.filter(({ status }) => status === 'superseded').length,
    activeExecutors: active.length,
    atBarrier: replays.some((replay) => replay.atBarrier === true),
    safeHead: primary.safeHead ?? null,
    ...(primary.reason ? { reason: primary.reason } : {}),
    ...(primary.expectedBackfillNextBlock
      ? { expectedBackfillNextBlock: primary.expectedBackfillNextBlock } : {}),
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
    concurrency: 1,
    lastResult: null, lastError: null, totalRuns: 0, totalErrors: 0,
    consecutiveErrors: 0, totalSeededTokens: 0, totalCommittedRanges: 0,
    totalDriftSuspicions: 0, totalDriftedTokens: 0,
    totalResyncingTokens: 0, totalSupersededTokens: 0, lastCompletedAt: null,
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
        maxInitialGapBlocks: options.maxInitialGapBlocks,
      });
      const settled = await Promise.allSettled(Array.from(
        { length: options.concurrency },
        (_, shardIndex) => runtime.executor.runOnce({
          rangeSize: options.rangeSize, confirmations: options.confirmations,
          shardCount: options.concurrency, shardIndex,
        })
      ));
      const failed = settled.find(({ status: outcome }) => outcome === 'rejected');
      if (failed) throw failed.reason;
      const replays = settled.map(({ value }) => value);
      const result = normalizeResult(seeded, replays);
      status.lastResult = result;
      status.lastError = null;
      status.consecutiveErrors = 0;
      status.totalSeededTokens += result.seededTokens;
      status.totalCommittedRanges += result.committedRanges;
      status.totalDriftSuspicions += result.driftSuspicions;
      status.totalDriftedTokens += result.driftedTokens;
      status.totalResyncingTokens += result.resyncingTokens;
      status.totalSupersededTokens += result.supersededTokens;
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
    status.concurrency = options.concurrency;
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
