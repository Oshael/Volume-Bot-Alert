const {
  createRobinhoodTokenHolderSummaryRepository,
} = require('../models/robinhood-token-holder-summary');
const {
  createRobinhoodBlockscoutHoldersClient,
} = require('./robinhood-blockscout-holders');
const {
  createRobinhoodHolderRequestScheduler,
  parseRetryAfterMs,
} = require('./robinhood-holder-request-scheduler');

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeOptions(input = {}) {
  const hotRefreshMs = boundedInteger(input.hotRefreshMs, 5 * 60_000, 60_000, 60 * 60_000);
  const failureBackoffMs = boundedInteger(input.failureBackoffMs, 5 * 60_000, 60_000, 60 * 60_000);
  return Object.freeze({
    enabled: input.enabled === true,
    intervalMs: boundedInteger(input.intervalMs, 30_000, 10_000, 60 * 60_000),
    batchSize: boundedInteger(input.batchSize, 20, 2, 50),
    hotWindowMs: boundedInteger(input.hotWindowMs, 60 * 60_000, 5 * 60_000, 24 * 60 * 60_000),
    hotRefreshMs,
    coldRefreshMs: Math.max(hotRefreshMs, boundedInteger(
      input.coldRefreshMs, 6 * 60 * 60_000, 5 * 60_000, 7 * 24 * 60 * 60_000
    )),
    failureBackoffMs,
    maxFailureBackoffMs: Math.max(failureBackoffMs, boundedInteger(
      input.maxFailureBackoffMs, 6 * 60 * 60_000, 60_000, 24 * 60 * 60_000
    )),
    unavailableRetryMs: boundedInteger(
      input.unavailableRetryMs, 24 * 60 * 60_000, 60 * 60_000, 7 * 24 * 60 * 60_000
    ),
    requestOptions: input.requestOptions || {},
  });
}

function safeErrorCode(error) {
  const raw = String(error?.code || 'provider_error').trim().toLowerCase();
  return raw.replace(/[^a-z0-9_:-]+/g, '_').slice(0, 64) || 'provider_error';
}

function createRobinhoodHolderSummaryWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  const repository = deps.repository || createRobinhoodTokenHolderSummaryRepository();
  let client = deps.client || null;
  let requestScheduler = deps.requestScheduler || null;
  let options = normalizeOptions();
  let timer = null;
  let running = false;
  let activeRun = null;
  const status = {
    enabled: false, running: false, inFlight: false,
    totalRuns: 0, totalUpdated: 0, totalUnavailable: 0, totalFailed: 0,
    lastRunAt: null, lastCompletedAt: null, lastError: null, lastSummary: null,
  };

  function services() {
    client ||= (deps.clientFactory || createRobinhoodBlockscoutHoldersClient)({ now });
    requestScheduler ||= (
      deps.schedulerFactory || createRobinhoodHolderRequestScheduler
    )(options.requestOptions);
    return { client, requestScheduler };
  }

  function retryAfterAt(candidate, error) {
    const providerDelay = parseRetryAfterMs(error, now());
    const fallback = Math.min(
      options.maxFailureBackoffMs,
      options.failureBackoffMs * (2 ** Math.min(candidate.consecutiveFailures, 8))
    );
    return new Date(now() + (providerDelay ?? fallback)).toISOString();
  }

  async function processCandidate(candidate) {
    const activeServices = services();
    let summary;
    try {
      summary = await activeServices.requestScheduler.schedule(
        () => activeServices.client.getTokenHolderSummary(candidate.tokenAddress)
      );
    } catch (error) {
      await repository.recordFailure({
        tokenAddress: candidate.tokenAddress,
        errorCode: safeErrorCode(error),
        retryAfterAt: retryAfterAt(candidate, error),
      });
      return 'failed';
    }
    if (!summary.available) {
      await repository.recordFailure({
        tokenAddress: candidate.tokenAddress,
        errorCode: 'unavailable',
        retryAfterAt: new Date(now() + options.unavailableRetryMs).toISOString(),
      });
      return 'unavailable';
    }
    await repository.recordSuccess({
      tokenAddress: candidate.tokenAddress,
      holderCount: summary.holderCount,
      observedAt: summary.observedAt,
    });
    return 'updated';
  }

  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      status.inFlight = true;
      status.lastRunAt = new Date(now()).toISOString();
      status.totalRuns += 1;
      try {
        const candidates = await repository.listRefreshCandidates({
          asOf: new Date(now()),
          limit: options.batchSize,
          coldQuota: Math.max(1, Math.floor(options.batchSize / 4)),
          hotWindowMs: options.hotWindowMs,
          hotRefreshMs: options.hotRefreshMs,
          coldRefreshMs: options.coldRefreshMs,
        });
        const settled = await Promise.allSettled(candidates.map(processCandidate));
        const counts = { updated: 0, unavailable: 0, failed: 0 };
        for (const result of settled) {
          if (result.status === 'fulfilled') counts[result.value] += 1;
          else counts.failed += 1;
        }
        const summary = Object.freeze({
          candidates: candidates.length,
          hot: candidates.filter(({ priority }) => priority === 'hot').length,
          cold: candidates.filter(({ priority }) => priority === 'cold').length,
          ...counts,
        });
        status.totalUpdated += counts.updated;
        status.totalUnavailable += counts.unavailable;
        status.totalFailed += counts.failed;
        status.lastSummary = summary;
        status.lastCompletedAt = new Date(now()).toISOString();
        status.lastError = null;
        return summary;
      } catch (error) {
        status.lastError = String(error?.message || error).slice(0, 500);
        throw error;
      } finally {
        status.inFlight = false;
        activeRun = null;
      }
    })();
    return activeRun;
  }

  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try { await runOnce(); } catch (error) {
        logger.error(`[RobinhoodHolderSummaryWorker] ${error.message}`);
      } finally { queueNext(options.intervalMs); }
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

  return Object.freeze({
    getStatus: () => ({
      ...status,
      requestScheduler: requestScheduler?.getStatus?.() || null,
    }),
    runOnce,
    start,
    stop,
  });
}

const worker = createRobinhoodHolderSummaryWorker();

module.exports = {
  createRobinhoodHolderSummaryWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { normalizeOptions, safeErrorCode },
};
