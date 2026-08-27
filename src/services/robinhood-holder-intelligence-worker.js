const {
  createRobinhoodHolderIntelligenceCandidateRepository,
} = require('../models/robinhood-holder-intelligence-candidate');
const {
  createRobinhoodHolderCexMaterializer,
} = require('./robinhood-holder-cex-materializer');
const {
  createRobinhoodHolderDevHoldMaterializer,
} = require('./robinhood-holder-dev-hold-materializer');
const {
  createRobinhoodHolderLpMaterializer,
} = require('./robinhood-holder-lp-materializer');
const {
  createRobinhoodHolderTopDistributionMaterializer,
} = require('./robinhood-holder-top-distribution-materializer');

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
    intervalMs: boundedInteger(input.intervalMs, 60_000, 10_000, 3_600_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(
      input.maxErrorBackoffMs, 300_000, 10_000, 3_600_000, 'maxErrorBackoffMs'
    ),
    batchSize: boundedInteger(input.batchSize, 20, 1, 100, 'batchSize'),
    concurrency: boundedInteger(input.concurrency, 2, 1, 8, 'concurrency'),
    unavailableRetryMs: boundedInteger(
      input.unavailableRetryMs, 3_600_000, 60_000, 86_400_000, 'unavailableRetryMs'
    ),
  });
}

function resultBucket(settled) {
  if (settled.status === 'rejected') return 'failed';
  return settled.value?.status === 'deferred' ? 'deferred' : 'completed';
}

function createRobinhoodHolderIntelligenceWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const candidates = deps.candidates
    || (deps.candidateFactory || createRobinhoodHolderIntelligenceCandidateRepository)();
  const materializers = deps.materializers || Object.freeze([
    (deps.topDistributionFactory || createRobinhoodHolderTopDistributionMaterializer)(),
    (deps.lpFactory || createRobinhoodHolderLpMaterializer)(),
    (deps.cexFactory || createRobinhoodHolderCexMaterializer)(),
    (deps.devHoldFactory || createRobinhoodHolderDevHoldMaterializer)(),
  ]);
  if (typeof candidates?.listCandidates !== 'function'
      || materializers.some((value) => typeof value?.materializeToken !== 'function')) {
    throw new TypeError('holder intelligence worker dependencies are invalid');
  }
  let options = normalizeOptions();
  let timer = null;
  let activeRun = null;
  let running = false;
  const status = {
    enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalCandidates: 0, totalCompleted: 0, totalDeferred: 0, totalFailed: 0,
    consecutiveErrors: 0, lastResult: null, lastError: null, lastCompletedAt: null,
  };

  async function materializeToken(tokenAddress) {
    return Promise.allSettled(materializers.map((value) => value.materializeToken(tokenAddress)));
  }

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const tokenAddresses = await candidates.listCandidates({
        limit: options.batchSize, unavailableRetryMs: options.unavailableRetryMs,
      });
      const counts = { completed: 0, deferred: 0, failed: 0 };
      for (let offset = 0; offset < tokenAddresses.length; offset += options.concurrency) {
        const batch = tokenAddresses.slice(offset, offset + options.concurrency);
        const tokenResults = await Promise.all(batch.map(materializeToken));
        for (const results of tokenResults) {
          for (const result of results) counts[resultBucket(result)] += 1;
        }
      }
      const result = Object.freeze({ candidates: tokenAddresses.length, ...counts });
      status.totalCandidates += tokenAddresses.length;
      status.totalCompleted += counts.completed;
      status.totalDeferred += counts.deferred;
      status.totalFailed += counts.failed;
      status.consecutiveErrors = 0;
      status.lastError = null;
      status.lastResult = result;
      return result;
    } catch (error) {
      status.consecutiveErrors += 1;
      status.lastError = Object.freeze({
        code: error.code || 'holder_intelligence_error',
        message: String(error.message || error).slice(0, 500),
      });
      logger.warn('[RobinhoodHolderIntelligenceWorker] Tick failed:', error.message);
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

const worker = createRobinhoodHolderIntelligenceWorker();

module.exports = {
  createRobinhoodHolderIntelligenceWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { normalizeOptions, resultBucket },
};
