'use strict';

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    enabled: input.enabled !== false,
    intervalMs: boundedInteger(input.intervalMs, 300_000, 10_000, 3_600_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(
      input.maxErrorBackoffMs, 1_800_000, 10_000, 3_600_000, 'maxErrorBackoffMs'
    ),
    batchLimit: boundedInteger(input.batchLimit, 1000, 1, 10_000, 'batchLimit'),
    maxBatches: boundedInteger(input.maxBatches, 5, 1, 20, 'maxBatches'),
  });
}

async function runRetentionTick(repository, options) {
  let batches = 0;
  let deletedCallouts = 0;
  let hasMore = false;
  do {
    const result = await repository.pruneExpiredCallouts({ batchLimit: options.batchLimit });
    batches += 1;
    deletedCallouts += Number(result.deletedCallouts) || 0;
    hasMore = result.hasMore === true;
  } while (hasMore && batches < options.maxBatches);
  return Object.freeze({
    status: deletedCallouts === 0 ? 'idle' : hasMore ? 'draining' : 'pruned',
    batches, deletedCallouts, batchBudgetExhausted: hasMore,
  });
}

function createCalloutRetentionWorker(deps = {}) {
  if (!deps.repository?.pruneExpiredCallouts) {
    throw new TypeError('Callout retention requires a capture repository');
  }
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  let options = normalizeOptions();
  let running = false;
  let timer = null;
  let activeRun = null;
  const status = {
    enabled: false, running: false, inFlight: false,
    totalRuns: 0, totalErrors: 0, consecutiveErrors: 0,
    totalBatches: 0, totalDeletedCallouts: 0,
    lastResult: null, lastErrorCode: null, lastCompletedAt: null,
  };

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const result = await runRetentionTick(deps.repository, options);
      status.lastResult = result;
      status.lastErrorCode = null;
      status.consecutiveErrors = 0;
      status.totalBatches += result.batches;
      status.totalDeletedCallouts += result.deletedCallouts;
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.consecutiveErrors += 1;
      status.lastErrorCode = String(error?.code || error?.name || 'CALLOUT_RETENTION_ERROR');
      logger.warn('[CalloutRetentionWorker] Tick failed:', status.lastErrorCode);
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
        ? Math.min(options.maxErrorBackoffMs, options.intervalMs * (2 ** Math.min(8, status.consecutiveErrors)))
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
    if (activeRun) await activeRun;
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

module.exports = {
  createCalloutRetentionWorker,
  __private: { normalizeOptions, runRetentionTick },
};
