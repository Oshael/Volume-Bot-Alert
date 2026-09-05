const db = require('../models/db');
const {
  createRobinhoodHolderBootstrapRepository,
} = require('../models/robinhood-holder-bootstrap');
const { createRobinhoodHolderHandoffRepository } = require('../models/robinhood-holder-handoff');
const { createRobinhoodHolderLedgerRepository } = require('../models/robinhood-holder-ledger');
const {
  createRobinhoodHolderHandoffCoordinator,
} = require('./robinhood-holder-handoff-coordinator');
const { createRobinhoodHolderLiveCapture } = require('./robinhood-holder-live-capture');
const { createRobinhoodHolderLiveRunner } = require('./robinhood-holder-live-runner');
const {
  normalizeRobinhoodHolderLiveSource,
  resolveRobinhoodHolderLiveSource,
} = require('./robinhood-holder-live-source');
const holderCountRealtime = require('./robinhood-holder-count-realtime');

const FATAL_CODES = new Set([
  'configuration_error', 'holder_live_apply_contract_error',
  'holder_live_capture_contract_error', 'holder_live_handoff_contract_error',
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value == null ? fallback : Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function normalizeOptions(options = {}, env = process.env) {
  const admittedAfter = options.admittedAfter == null ? null : new Date(options.admittedAfter);
  if ((options.enabled === true && !admittedAfter)
      || (admittedAfter && !Number.isFinite(admittedAfter.getTime()))) {
    const error = new Error('holder live admittedAfter is required');
    error.code = 'configuration_error';
    throw error;
  }
  return Object.freeze({
    enabled: options.enabled === true,
    sourceMode: normalizeRobinhoodHolderLiveSource(
      options.sourceMode ?? env.ROBINHOOD_HOLDER_LIVE_SOURCE
    ),
    intervalMs: boundedInteger(options.intervalMs, 500, 100, 300_000),
    maxErrorBackoffMs: boundedInteger(options.maxErrorBackoffMs, 30_000, 1000, 300_000),
    rangeSize: boundedInteger(options.rangeSize, 250, 1, 5000),
    confirmations: boundedInteger(options.confirmations, 12, 0, 1000),
    addressShardConcurrency: boundedInteger(options.addressShardConcurrency, 2, 1, 4),
    admittedAfter: admittedAfter?.toISOString() || null,
    seedLimit: boundedInteger(options.seedLimit, 100, 1, 1000),
    maxInitialGapBlocks: boundedInteger(options.maxInitialGapBlocks, 20_000, 1, 100_000_000),
    rpcTimeoutMs: boundedInteger(
      options.rpcTimeoutMs ?? env.ROBINHOOD_RPC_TIMEOUT_MS, 15_000, 1000, 60_000
    ),
  });
}

function resolveHolderCountPublisher(deps) {
  return deps.publishHolderCounts || holderCountRealtime.publishUpdates;
}

function resolveBootstrap(deps, database) {
  return deps.bootstrap
    || (deps.bootstrapFactory || createRobinhoodHolderBootstrapRepository)({ database });
}

async function buildRuntime(options, deps = {}) {
  const database = deps.database || db;
  const source = await resolveRobinhoodHolderLiveSource({
    sourceMode: options.sourceMode,
    providerName: 'robinhood-holder-live',
    rpcTimeoutMs: options.rpcTimeoutMs,
    addressShardConcurrency: options.addressShardConcurrency,
  }, { ...deps, database });
  const ledger = deps.ledger || (deps.ledgerFactory || createRobinhoodHolderLedgerRepository)({
    database,
  });
  const bootstrap = resolveBootstrap(deps, database);
  const { reader } = source;
  const capture = deps.capture || (deps.captureFactory || createRobinhoodHolderLiveCapture)({
    bootstrap, ledger, reader,
  });
  const handoffRepository = deps.handoffRepository
    || (deps.handoffRepositoryFactory || createRobinhoodHolderHandoffRepository)({ database });
  const handoff = deps.handoff
    || (deps.handoffFactory || createRobinhoodHolderHandoffCoordinator)({
      repository: handoffRepository, reader,
    });
  const runner = deps.runner || (deps.runnerFactory || createRobinhoodHolderLiveRunner)({
    capture, handoff, ledger, reader,
    publishHolderCounts: resolveHolderCountPublisher(deps),
  });
  return Object.freeze({
    sourceMode: source.sourceMode, providerName: source.providerName, runner,
  });
}

function publicError(error) {
  return error ? Object.freeze({
    code: error.code || 'holder_live_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
  }) : null;
}

function numericMetric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableMetric(value) {
  return value == null ? null : value;
}

function compactResult(result) {
  if (!result) return null;
  return Object.freeze({
    status: result.status || null,
    captureStatus: result.captureStatus || null,
    nextBlock: result.nextBlock ?? null,
    safeHead: result.safeHead ?? null,
    capturedTransfers: numericMetric(result.capturedTransfers),
    seededTokens: numericMetric(result.seededTokens),
    bufferedSeededTokens: numericMetric(result.bufferedSeededTokens),
    handoffStatus: result.handoffStatus || null,
    handoffPromotions: Number(result.handoffPromotions) || 0,
    handoffResyncs: Number(result.handoffResyncs) || 0,
    appliedEvents: Number(result.appliedEvents) || 0,
    driftedTokens: Number(result.driftedTokens) || 0,
    driftSuspicions: Number(result.driftSuspicions) || 0,
    receiptRecoveries: Number(result.receiptRecoveries) || 0,
    driftDeferred: Number(result.driftDeferred) || 0,
    tailRollbacks: numericMetric(result.tailRollbacks),
    tailRollbackEvents: numericMetric(result.tailRollbackEvents),
    quarantinedTokenAddress: nullableMetric(result.quarantinedTokenAddress),
    quarantinedTokens: numericMetric(result.quarantinedTokens),
    applyBudgetExhausted: result.applyBudgetExhausted === true,
    holderCountUpdates: Number(result.holderCountUpdates) || 0,
    holderCountPublished: Number(result.holderCountPublished) || 0,
  });
}

function createRobinhoodHolderLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const runtimeFactory = deps.runtimeFactory || ((options) => buildRuntime(options, deps));
  let options = normalizeOptions({}, env);
  let runtimePromise = null;
  let timer = null;
  let activeRunPromise = null;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    sourceMode: null, providerName: null, lastResult: null, lastError: null,
    totalRuns: 0, totalErrors: 0, consecutiveErrors: 0,
    totalCapturedTransfers: 0, totalSeededTokens: 0, totalBufferedSeededTokens: 0,
    totalAppliedEvents: 0,
    totalHolderCountUpdates: 0, totalHolderCountPublished: 0,
    totalHandoffPromotions: 0, totalHandoffResyncs: 0,
    totalDriftedTokens: 0, totalDriftSuspicions: 0,
    totalReceiptRecoveries: 0, totalTailRollbacks: 0, totalTailRollbackEvents: 0,
    totalMalformedTokenQuarantines: 0, totalRecoveries: 0, lastCompletedAt: null,
  };

  async function getRuntime() {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve(runtimeFactory(options)).catch((error) => {
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
      logger.error('[RobinhoodHolderLiveWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  function recordResult(result) {
    status.lastResult = compactResult(result);
    status.totalCapturedTransfers += Number(result.capturedTransfers) || 0;
    status.totalSeededTokens += Number(result.seededTokens) || 0;
    status.totalBufferedSeededTokens += Number(result.bufferedSeededTokens) || 0;
    status.totalHandoffPromotions += Number(result.handoffPromotions) || 0;
    status.totalHandoffResyncs += Number(result.handoffResyncs) || 0;
    status.totalAppliedEvents += Number(result.appliedEvents) || 0;
    status.totalHolderCountUpdates += Number(result.holderCountUpdates) || 0;
    status.totalHolderCountPublished += Number(result.holderCountPublished) || 0;
    status.totalDriftedTokens += Number(result.driftedTokens) || 0;
    status.totalDriftSuspicions += Number(result.driftSuspicions) || 0;
    status.totalReceiptRecoveries += Number(result.receiptRecoveries) || 0;
    status.totalTailRollbacks += Number(result.tailRollbacks) || 0;
    status.totalTailRollbackEvents += Number(result.tailRollbackEvents) || 0;
    status.totalMalformedTokenQuarantines += Number(result.quarantinedTokens) || 0;
    if (result.status === 'recovered') status.totalRecoveries += 1;
  }

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const runtime = await getRuntime();
      status.sourceMode = runtime.sourceMode;
      status.providerName = runtime.providerName;
      const result = await runtime.runner.captureOnce(options);
      recordResult(result);
      status.consecutiveErrors = 0;
      status.lastError = null;
      if (result.status === 'blocked') {
        const error = new Error(`holder live recovery blocked: ${result.reason}`);
        error.code = 'holder_reorg_unrecoverable';
        error.fatal = true;
        await halt(error);
      }
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.consecutiveErrors += 1;
      status.lastError = publicError(error);
      if (error.fatal === true || FATAL_CODES.has(error.code)) await halt(error);
      else logger.warn('[RobinhoodHolderLiveWorker] Tick failed:', error.message);
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
    options = normalizeOptions(input, env);
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

const worker = createRobinhoodHolderLiveWorker();

module.exports = {
  createRobinhoodHolderLiveWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { buildRuntime, compactResult, normalizeOptions },
};
