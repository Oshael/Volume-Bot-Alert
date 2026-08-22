const { createRobinhoodSniperShadowRunner } = require('./robinhood-sniper-shadow-runner');

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    enabled: input.enabled === true,
    intervalMs: boundedInteger(input.intervalMs, 10_000, 1_000, 3_600_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(
      input.maxErrorBackoffMs, 300_000, 1_000, 3_600_000, 'maxErrorBackoffMs'
    ),
    batchSize: boundedInteger(input.batchSize, 10, 1, 100, 'batchSize'),
    concurrency: boundedInteger(input.concurrency, 1, 1, 4, 'concurrency'),
    retryMs: boundedInteger(input.retryMs, 3_600_000, 60_000, 86_400_000, 'retryMs'),
  });
}

function createRobinhoodSniperShadowWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const runner = deps.runner || (deps.runnerFactory || createRobinhoodSniperShadowRunner)();
  if (typeof runner?.runBatch !== 'function') {
    throw new TypeError('SNIPER shadow worker runner is invalid');
  }
  let options = normalizeOptions();
  let timer = null;
  let activeRun = null;
  let running = false;
  let afterToken = null;
  const status = {
    enabled: false, running: false, inFlight: false, mode: 'shadow',
    totalRuns: 0, totalCandidates: 0, totalCompleted: 0,
    totalDeferred: 0, totalFailed: 0, consecutiveErrors: 0,
    scanAfterToken: null, lastResult: null, lastError: null, lastCompletedAt: null,
  };

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const result = await runner.runBatch({
        limit: options.batchSize, concurrency: options.concurrency,
        retryMs: options.retryMs, afterToken,
      });
      afterToken = result.exhausted ? null : result.nextToken;
      status.scanAfterToken = afterToken;
      status.totalCandidates += result.candidates;
      status.totalCompleted += result.completed;
      status.totalDeferred += result.deferred;
      status.totalFailed += result.failed;
      status.consecutiveErrors = 0;
      status.lastError = null;
      status.lastResult = result;
      return result;
    } catch (error) {
      status.consecutiveErrors += 1;
      status.lastError = Object.freeze({
        code: error.code || 'sniper_shadow_error',
        message: String(error.message || error).slice(0, 500),
      });
      logger.warn('[RobinhoodSniperShadowWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date().toISOString();
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

const worker = createRobinhoodSniperShadowWorker();

module.exports = {
  createRobinhoodSniperShadowWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { normalizeOptions },
};
