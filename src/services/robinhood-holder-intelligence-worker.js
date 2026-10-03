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
const { createHolderIntelligenceRetry } = require('./robinhood-holder-intelligence-retry');

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
  const retry = createHolderIntelligenceRetry({ now: deps.now });
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
  let afterToken = null;
  const status = {
    enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalCandidates: 0, totalCompleted: 0, totalDeferred: 0, totalFailed: 0,
    consecutiveErrors: 0, lastResult: null, lastError: null, lastCompletedAt: null,
    scanAfterToken: null, lastSelection: null, lastFailure: null,
    totalRetryDeferred: 0, totalUnanchored: 0, cachedRetryTokens: 0,
  };

  async function selectPage() {
    const input = { limit: options.batchSize,
      unavailableRetryMs: options.unavailableRetryMs, afterToken };
    if (candidates.listCandidatePage) return candidates.listCandidatePage(input);
    return { candidates: (await candidates.listCandidates(input))
      .map((tokenAddress) => ({ tokenAddress })), exhausted: true, scanned: 0, unanchored: 0 };
  }

  async function materializeToken(candidate) {
    const results = await Promise.allSettled(materializers
      .map((value) => value.materializeToken(candidate.tokenAddress)));
    return { results, error: retry.record(candidate, results, options) };
  }

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const page = await selectPage();
      const due = page.candidates.filter(retry.isDue);
      const retryDeferred = page.candidates.length - due.length;
      const counts = { completed: 0, deferred: 0, failed: 0 };
      let firstError = null;
      for (let offset = 0; offset < due.length; offset += options.concurrency) {
        const batch = due.slice(offset, offset + options.concurrency);
        const tokenResults = await Promise.all(batch.map(materializeToken));
        for (const { results, error } of tokenResults) {
          firstError ||= error;
          for (const result of results) counts[resultBucket(result)] += 1;
        }
      }
      afterToken = page.exhausted ? null : page.nextToken;
      status.scanAfterToken = afterToken;
      status.lastSelection = { scanned: page.scanned, unanchored: page.unanchored,
        selected: page.candidates.length, retryDeferred, exhausted: page.exhausted };
      status.totalRetryDeferred += retryDeferred;
      status.totalUnanchored += page.unanchored;
      status.cachedRetryTokens = retry.getSize();
      const result = Object.freeze({ candidates: due.length, ...counts });
      status.totalCandidates += due.length;
      status.totalCompleted += counts.completed;
      status.totalDeferred += counts.deferred;
      status.totalFailed += counts.failed;
      status.consecutiveErrors = 0;
      status.lastError = firstError;
      if (firstError) status.lastFailure = { ...firstError, at: new Date().toISOString() };
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
