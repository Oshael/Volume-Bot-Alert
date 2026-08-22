const {
  createRobinhoodFirstBuyLiveCursorRepository,
} = require('../models/robinhood-first-buy-live-cursor');
const {
  createRobinhoodWalletTokenFirstBuyRepository,
} = require('../models/robinhood-wallet-token-first-buy');
const {
  createRobinhoodWalletSwapCursorRepository,
} = require('../models/robinhood-wallet-swap-cursor');
const { runFirstBuyLiveTick } = require('./robinhood-first-buy-live-runner');

const FATAL_CODES = new Set([
  'first_buy_position_unavailable', 'first_buy_seed_mismatch', 'source_frontier_regressed',
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(Math.trunc(parsed), maximum)) : fallback;
}

function normalizeOptions(input = {}) {
  const seedRunId = String(input.seedRunId || '').trim();
  return Object.freeze({
    enabled: input.enabled === true,
    seedRunId: /^\d+$/.test(seedRunId) ? seedRunId : null,
    intervalMs: boundedInteger(input.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(input.maxErrorBackoffMs, 30_000, 1000, 300_000),
    rangeSeconds: boundedInteger(input.rangeSeconds, 300, 60, 86_400),
  });
}

function lagMs(result) {
  if (!result?.nextTime || !result?.sourceThrough) return null;
  return Math.max(0, new Date(result.sourceThrough) - new Date(result.nextTime));
}

function createRobinhoodFirstBuyLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const tick = deps.runTick || runFirstBuyLiveTick;
  let options = normalizeOptions();
  let runtime = null;
  let timer = null;
  let active = null;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    totalRuns: 0, totalRowsScanned: 0, totalFactsConsidered: 0, totalFactsWritten: 0,
    consecutiveErrors: 0, lagMs: null, lastResult: null,
    lastError: null, lastCompletedAt: null,
  };

  function getRuntime() {
    if (!runtime) runtime = {
      sourceCursors: (deps.sourceCursorFactory || createRobinhoodWalletSwapCursorRepository)(),
      liveCursor: (deps.liveCursorFactory || createRobinhoodFirstBuyLiveCursorRepository)(),
      writer: (deps.writerFactory || createRobinhoodWalletTokenFirstBuyRepository)(),
    };
    return runtime;
  }

  async function halt(error) {
    running = false;
    status.running = false;
    status.halted = true;
    if (timer) cancelSchedule(timer);
    timer = null;
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodFirstBuyLiveWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const result = await tick(getRuntime(), options);
      status.lastResult = result;
      status.lagMs = lagMs(result);
      status.totalRowsScanned += Number(result.rowsScanned || 0);
      status.totalFactsConsidered += Number(result.factsConsidered || 0);
      status.totalFactsWritten += Number(result.factsWritten || 0);
      status.consecutiveErrors = 0;
      status.lastError = null;
      return result;
    } catch (error) {
      status.consecutiveErrors += 1;
      status.lastError = {
        code: error.code || 'first_buy_live_error',
        message: String(error.message || error).slice(0, 500),
      };
      if (error.fatal === true || FATAL_CODES.has(error.code)) await halt(error);
      else logger.warn('[RobinhoodFirstBuyLiveWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date().toISOString();
    }
  }

  async function runOnce() {
    if (active) return active;
    active = execute().finally(() => { active = null; });
    return active;
  }

  function queueNext(delayMs) {
    if (!running || status.halted) return;
    timer = schedule(async () => {
      await runOnce();
      const backoff = Math.min(
        options.maxErrorBackoffMs,
        options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8))
      );
      queueNext(status.consecutiveErrors ? backoff : options.intervalMs);
    }, delayMs);
    timer?.unref?.();
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    status.enabled = options.enabled;
    onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    if (!options.enabled) return false;
    if (!options.seedRunId) throw new Error('first-buy LIVE seedRunId is required');
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
    if (active) await active.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodFirstBuyLiveWorker();

module.exports = {
  createRobinhoodFirstBuyLiveWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { normalizeOptions },
};
