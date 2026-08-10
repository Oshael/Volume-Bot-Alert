const db = require('../models/db');
const {
  createRobinhoodHolderJournalRetention,
} = require('../models/robinhood-holder-journal-retention');

const TERMINAL_STATUSES = new Set(['idle', 'blocked', 'pruned']);

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
    retentionBlocks: boundedInteger(
      input.retentionBlocks, 20_000, 1, 1_000_000, 'retentionBlocks'
    ),
    batchLimit: boundedInteger(input.batchLimit, 5000, 1, 50_000, 'batchLimit'),
    maxBatches: boundedInteger(input.maxBatches, 5, 1, 50, 'maxBatches'),
  });
}

function publicError(error) {
  return Object.freeze({
    code: error.code || 'holder_journal_prune_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
  });
}

function validatePruneResult(result) {
  if (!['idle', 'blocked', 'draining', 'pruned'].includes(result?.status)) {
    const error = new Error(`unexpected holder journal prune status: ${result?.status}`);
    error.code = 'holder_journal_prune_contract_error';
    throw error;
  }
  return result;
}

async function runPruneTick(retention, options) {
  let batches = 0;
  let deletedEvents = 0;
  let last = null;
  while (batches < options.maxBatches) {
    last = validatePruneResult(await retention.pruneOnce({
      retentionBlocks: options.retentionBlocks, batchLimit: options.batchLimit,
    }));
    batches += 1;
    deletedEvents += Number(last.deletedEvents) || 0;
    if (TERMINAL_STATUSES.has(last.status)) break;
  }
  return Object.freeze({
    status: last.status,
    batches,
    deletedEvents,
    reason: last.reason || null,
    cutoffBlock: last.cutoffBlock ?? null,
    journalFloorBlock: last.journalFloorBlock ?? null,
    batchBudgetExhausted: last.status === 'draining' && batches === options.maxBatches,
  });
}

function createRobinhoodHolderJournalPruneWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const retention = deps.retention
    || (deps.retentionFactory || createRobinhoodHolderJournalRetention)({
      database: deps.database || db,
    });
  let options = normalizeOptions();
  let timer = null;
  let activeRunPromise = null;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    lastResult: null, lastError: null, totalRuns: 0, totalErrors: 0,
    consecutiveErrors: 0, totalBatches: 0, totalDeletedEvents: 0,
    totalBlockedRuns: 0, lastCompletedAt: null,
  };

  async function halt(error) {
    running = false;
    status.running = false;
    status.halted = true;
    status.lastError = publicError(error);
    if (timer) cancelSchedule(timer);
    timer = null;
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodHolderJournalPruneWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const result = await runPruneTick(retention, options);
      status.lastResult = result;
      status.lastError = null;
      status.consecutiveErrors = 0;
      status.totalBatches += result.batches;
      status.totalDeletedEvents += result.deletedEvents;
      if (result.status === 'blocked') status.totalBlockedRuns += 1;
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.consecutiveErrors += 1;
      status.lastError = publicError(error);
      if (error.code === 'holder_journal_prune_contract_error') await halt(error);
      else logger.warn('[RobinhoodHolderJournalPruneWorker] Tick failed:', error.message);
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

const worker = createRobinhoodHolderJournalPruneWorker();

module.exports = {
  createRobinhoodHolderJournalPruneWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { normalizeOptions, runPruneTick },
};
