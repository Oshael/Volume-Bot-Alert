const db = require('../models/db');
const {
  CANONICAL_SOURCE, buildRobinhoodWalletTransferRuntime,
  normalizeRobinhoodWalletTransferSource,
} = require('./robinhood-wallet-transfer-runtime');
const {
  runRobinhoodWalletTransferLiveTick,
} = require('./robinhood-wallet-transfer-live-tick');
const {
  NOTIFY_CHANNEL: CANONICAL_CAPTURE_NOTIFY_CHANNEL,
} = require('../models/robinhood-chain-capture-journal');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const FATAL_CODES = new Set([
  'configuration_error', 'source_contract_error', 'transfer_source_frontier_regressed',
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value == null ? fallback : Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function normalizeOptions(input = {}, env = process.env) {
  return Object.freeze({
    enabled: input.enabled === true,
    sourceMode: normalizeRobinhoodWalletTransferSource(
      input.sourceMode ?? env.ROBINHOOD_WALLET_TRANSFER_LIVE_SOURCE
    ),
    intervalMs: boundedInteger(input.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(input.maxErrorBackoffMs, 30_000, 1000, 300_000),
    maxBlocks: boundedInteger(input.maxBlocks, 25, 1, 250),
    addressShardConcurrency: boundedInteger(input.addressShardConcurrency, 1, 1, 4),
    blockEvidenceBatchSize: boundedInteger(input.blockEvidenceBatchSize, 50, 1, 100),
    endpointRoleBatchSize: boundedInteger(input.endpointRoleBatchSize, 50, 1, 100),
    unifiedPositionEnabled: input.unifiedPositionEnabled === true,
    rpcOptions: input.rpcOptions || {},
  });
}

const buildRuntime = buildRobinhoodWalletTransferRuntime;

function publicError(error) {
  return error ? Object.freeze({
    code: error.code || 'wallet_transfer_live_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
  }) : null;
}

function count(value) {
  return Number(value) || 0;
}

function compactResult(result) {
  if (!result) return null;
  return Object.freeze({
    status: result.status || null, reason: result.reason || null,
    fromBlock: result.fromBlock ?? null, toBlock: result.toBlock ?? null,
    nextBlock: result.nextBlock ?? null, sourceThrough: result.sourceThrough ?? null,
    scopeTokens: count(result.scopeTokens),
    transfers: count(result.transfers),
    rawInserted: count(result.rawInserted),
    edgeGroups: count(result.edgeGroups),
    evidenceCandidates: count(result.evidenceCandidates),
    classifications: result.classifications || {},
    transferFilterMode: result.telemetry?.filterMode || null,
    transferLogRequests: count(result.telemetry?.requests),
    transferRangeSplits: count(result.telemetry?.splits),
    transferAddressSplits: count(result.telemetry?.addressSplits),
    endpointRoleProbes: count(result.telemetry?.endpointRoles?.probes),
    unifiedPosition: result.unifiedPosition || null,
  });
}

function createRobinhoodWalletTransferLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const runtimeFactory = deps.runtimeFactory || ((options) => buildRuntime(options, deps));
  const tick = deps.runTick || runRobinhoodWalletTransferLiveTick;
  let options = normalizeOptions({}, env);
  let runtimePromise = null;
  let timer = null;
  let listener = null;
  let active = null;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, halted: false, inFlight: false, sourceMode: null,
    providerChainIds: null, lastResult: null, lastError: null,
    totalRuns: 0, totalErrors: 0, consecutiveErrors: 0,
    totalTransfers: 0, totalRawInserted: 0, totalEdgeGroups: 0,
    totalEvidenceCandidates: 0, totalEndpointRoleProbes: 0,
    cursorConflicts: 0, lastCompletedAt: null,
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
    running = false; status.running = false; status.halted = true;
    status.lastError = publicError(error);
    if (timer) cancelSchedule(timer);
    timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {});
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodWalletTransferLiveWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  function recordResult(result) {
    const compact = compactResult(result);
    status.lastResult = compact;
    status.totalTransfers += compact.transfers;
    status.totalRawInserted += compact.rawInserted;
    status.totalEdgeGroups += compact.edgeGroups;
    status.totalEvidenceCandidates += compact.evidenceCandidates;
    status.totalEndpointRoleProbes += compact.endpointRoleProbes;
    if (compact.status === 'cursor-conflict') status.cursorConflicts += 1;
  }

  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    try {
      const runtime = await getRuntime();
      status.sourceMode = runtime.sourceMode;
      status.providerChainIds = runtime.providerChainIds;
      const result = await tick(runtime.tickDeps, {
        maxBlocks: options.maxBlocks,
        unifiedPositionEnabled: options.unifiedPositionEnabled,
      });
      recordResult(result);
      status.lastError = null; status.consecutiveErrors = 0;
      if (result.status === 'blocked') {
        const error = Object.assign(new Error(`transfer LIVE blocked: ${result.reason}`), {
          code: 'transfer_checkpoint_mismatch', fatal: true,
        });
        await halt(error);
      }
      return result;
    } catch (error) {
      status.totalErrors += 1; status.consecutiveErrors += 1;
      status.lastError = publicError(error);
      if (error.fatal === true || FATAL_CODES.has(error.code)) await halt(error);
      else logger.warn('[RobinhoodWalletTransferLiveWorker] Tick failed:', error.message);
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

  function queueNext(delay) {
    if (!running || status.halted || timer) return;
    timer = schedule(async () => {
      timer = null;
      await runOnce();
      const backoff = Math.min(
        options.maxErrorBackoffMs,
        options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8))
      );
      queueNext(status.consecutiveErrors ? backoff : options.intervalMs);
    }, delay);
    timer?.unref?.();
  }

  function wake() {
    if (!running || status.halted) return;
    if (timer) cancelSchedule(timer);
    timer = null;
    queueNext(0);
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input, env);
    onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    status.halted = false; running = true; status.running = true;
    if (options.sourceMode === CANONICAL_SOURCE) {
      listener = (deps.listenerFactory || createPostgresRealtimeListener)({
        channel: CANONICAL_CAPTURE_NOTIFY_CHANNEL,
        label: 'RobinhoodWalletTransferLiveWorker',
        pool: deps.pool || db.pool,
        onNotification: wake,
      });
      Promise.resolve(listener.start()).catch((error) => {
        status.lastError = publicError(error);
      });
    }
    queueNext(0);
    return true;
  }

  async function stop() {
    running = false; status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {});
    if (active) await active.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodWalletTransferLiveWorker();

module.exports = {
  createRobinhoodWalletTransferLiveWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { buildRuntime, compactResult, normalizeOptions },
};
