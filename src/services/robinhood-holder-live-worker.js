const db = require('../models/db');
const { createRobinhoodHolderHandoffRepository } = require('../models/robinhood-holder-handoff');
const { createRobinhoodHolderLedgerRepository } = require('../models/robinhood-holder-ledger');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const {
  createRobinhoodHolderHandoffCoordinator,
} = require('./robinhood-holder-handoff-coordinator');
const { createRobinhoodHolderLiveCapture } = require('./robinhood-holder-live-capture');
const { createRobinhoodHolderLiveRunner } = require('./robinhood-holder-live-runner');
const holderCountRealtime = require('./robinhood-holder-count-realtime');
const { resolveRobinhoodHolderRpcProvider } = require('./robinhood-holder-rpc');
const { createRobinhoodHolderTransferReader } = require('./robinhood-holder-transfer-reader');

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
  return Object.freeze({
    enabled: options.enabled === true,
    intervalMs: boundedInteger(options.intervalMs, 500, 100, 300_000),
    maxErrorBackoffMs: boundedInteger(options.maxErrorBackoffMs, 30_000, 1000, 300_000),
    rangeSize: boundedInteger(options.rangeSize, 250, 1, 5000),
    confirmations: boundedInteger(options.confirmations, 12, 0, 1000),
    maxApplyEvents: boundedInteger(options.maxApplyEvents, 5000, 1, 50_000),
    addressShardConcurrency: boundedInteger(options.addressShardConcurrency, 2, 1, 4),
    rpcTimeoutMs: boundedInteger(
      options.rpcTimeoutMs ?? env.ROBINHOOD_RPC_TIMEOUT_MS, 15_000, 1000, 60_000
    ),
  });
}

function resolveHolderCountPublisher(deps) {
  return deps.publishHolderCounts || holderCountRealtime.publishUpdates;
}

async function buildRuntime(options, deps = {}) {
  const database = deps.database || db;
  const provider = resolveRobinhoodHolderRpcProvider(
    deps.env || process.env, 'robinhood-holder-live'
  );
  const rpcClient = deps.rpcClient || (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [provider], timeoutMs: options.rpcTimeoutMs, maxRetries: 1,
  });
  const ledger = deps.ledger || (deps.ledgerFactory || createRobinhoodHolderLedgerRepository)({
    database,
  });
  const reader = deps.reader || (deps.readerFactory || createRobinhoodHolderTransferReader)({
    rpcClient, addressShardConcurrency: options.addressShardConcurrency,
  });
  await reader.assertChain();
  const capture = deps.capture || (deps.captureFactory || createRobinhoodHolderLiveCapture)({
    ledger, reader,
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
  return Object.freeze({ providerName: provider.name, runner });
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

function compactResult(result) {
  if (!result) return null;
  return Object.freeze({
    status: result.status || null,
    captureStatus: result.captureStatus || null,
    nextBlock: result.nextBlock ?? null,
    safeHead: result.safeHead ?? null,
    capturedTransfers: Number(result.capturedTransfers) || 0,
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
    providerName: null, lastResult: null, lastError: null,
    totalRuns: 0, totalErrors: 0, consecutiveErrors: 0,
    totalCapturedTransfers: 0, totalAppliedEvents: 0,
    totalHolderCountUpdates: 0, totalHolderCountPublished: 0,
    totalHandoffPromotions: 0, totalHandoffResyncs: 0,
    totalDriftedTokens: 0, totalDriftSuspicions: 0,
    totalReceiptRecoveries: 0, totalTailRollbacks: 0, totalTailRollbackEvents: 0,
    totalRecoveries: 0, lastCompletedAt: null,
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
    if (result.status === 'recovered') status.totalRecoveries += 1;
  }

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const runtime = await getRuntime();
      status.providerName = runtime.providerName;
      const result = await runtime.runner.runOnce(options);
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
