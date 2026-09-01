const db = require('../models/db');
const { createRobinhoodHolderGlobalDeltaRepository } = require('../models/robinhood-holder-global-delta');
const { createRobinhoodHolderGlobalBackfillRepository } = require('../models/robinhood-holder-global-backfill');
const { createRobinhoodHolderGlobalBackfillCommitRepository } = require('../models/robinhood-holder-global-backfill-commit');
const { createRobinhoodHolderLedgerRepository } = require('../models/robinhood-holder-ledger');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { createRobinhoodHolderGlobalBackfillAttach } = require('./robinhood-holder-global-backfill-attach');
const { createRobinhoodHolderGlobalBackfillScanner } = require('./robinhood-holder-global-backfill-scanner');
const { resolveRobinhoodHolderRpcProvider } = require('./robinhood-holder-rpc');
const { createRobinhoodHolderTransferReader } = require('./robinhood-holder-transfer-reader');
function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw Object.assign(new Error(`${label} must be between ${minimum} and ${maximum}`), {
      code: 'configuration_error',
    });
  }
  return parsed;
}
function normalizeOptions(input = {}) {
  const enabled = input.enabled === true;
  const rollingEnabled = input.rollingEnabled === true;
  const cutoff = input.catalogCutoff == null ? null : new Date(input.catalogCutoff);
  if (enabled && (!cutoff || !Number.isFinite(cutoff.getTime()))) {
    throw Object.assign(new Error('global holder catalogCutoff is required'), {
      code: 'configuration_error',
    });
  }
  if (enabled && rollingEnabled && input.autoStart !== true) {
    throw Object.assign(new Error('rolling global holder backfill requires autoStart'), {
      code: 'configuration_error',
    });
  }
  return Object.freeze({
    enabled, autoStart: input.autoStart === true,
    rollingEnabled,
    catalogCutoff: cutoff?.toISOString() || null,
    intervalMs: boundedInteger(input.intervalMs, 1000, 250, 300_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(
      input.maxErrorBackoffMs, 30_000, 1000, 300_000, 'maxErrorBackoffMs'
    ),
    rangeSize: boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize'),
    prefetch: boundedInteger(input.prefetch, 1, 1, 8, 'prefetch'),
    maxCommitMs: boundedInteger(input.maxCommitMs, 2000, 1, 300_000, 'maxCommitMs'),
    addressShardConcurrency: boundedInteger(
      input.addressShardConcurrency, 1, 1, 4, 'addressShardConcurrency'
    ),
    finalityBlocks: boundedInteger(input.finalityBlocks, 2000, 2000, 100_000, 'finalityBlocks'),
    attachWindow: boundedInteger(input.attachWindow, 10_000, 1, 19_999, 'attachWindow'),
    materializeBatchSize: boundedInteger(
      input.materializeBatchSize, 1000, 1, 5000, 'materializeBatchSize'
    ),
    rollingDelayMs: boundedInteger(
      input.rollingDelayMs, 3_600_000, 60_000, 86_400_000, 'rollingDelayMs'
    ),
    rollingCheckIntervalMs: boundedInteger(
      input.rollingCheckIntervalMs, 300_000, 60_000, 3_600_000, 'rollingCheckIntervalMs'
    ),
    rollingMinTokens: boundedInteger(
      input.rollingMinTokens, 1, 1, 100_000, 'rollingMinTokens'
    ),
    rollingMinGapBlocks: boundedInteger(
      input.rollingMinGapBlocks, 20_000, 1, 100_000_000, 'rollingMinGapBlocks'
    ),
    liveConfirmations: boundedInteger(input.liveConfirmations, 12, 0, 1000, 'liveConfirmations'),
  });
}
async function buildRuntime(options, deps = {}) {
  const database = deps.database || db;
  const provider = resolveRobinhoodHolderRpcProvider(
    deps.env || process.env, 'robinhood-holder-global-backfill',
    'ROBINHOOD_HOLDER_GLOBAL_BACKFILL_RPC_URL'
  );
  const rpcClient = deps.rpcClient || (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [provider], timeoutMs: 15_000, maxRetries: 1,
  });
  const lifecycle = (deps.lifecycleFactory || createRobinhoodHolderGlobalBackfillRepository)({
    database,
  });
  const delta = (deps.deltaFactory || createRobinhoodHolderGlobalDeltaRepository)({ database });
  const committer = (deps.committerFactory
    || createRobinhoodHolderGlobalBackfillCommitRepository)({ database });
  const ledger = (deps.ledgerFactory || createRobinhoodHolderLedgerRepository)({ database });
  const reader = (deps.readerFactory || createRobinhoodHolderTransferReader)({
    rpcClient, addressShardConcurrency: options.addressShardConcurrency,
  });
  await reader.assertChain();
  const scanner = (deps.scannerFactory || createRobinhoodHolderGlobalBackfillScanner)({
    lifecycleRepository: lifecycle, commitRepository: committer, reader,
    options: {
      rangeSize: options.rangeSize, prefetch: options.prefetch,
      finalityBlocks: options.finalityBlocks, maxCommitMs: options.maxCommitMs,
    },
  });
  const materializer = (deps.attachFactory || createRobinhoodHolderGlobalBackfillAttach)({
    repository: lifecycle, reader,
  });
  return Object.freeze({
    delta, lifecycle, ledger, materializer, providerName: provider.name, reader, scanner,
  });
}
async function liveContext(runtime, options, run) {
  const cursor = await runtime.ledger.getCursor();
  if (!cursor) return { barrierDistance: null, liveLagBlocks: null };
  const head = await runtime.reader.getSafeHead(options.liveConfirmations);
  const liveLag = BigInt(head.safeHead) - BigInt(cursor.nextBlock) + 1n;
  const target = run.barrierBlock == null ? BigInt(cursor.nextBlock) : BigInt(run.barrierBlock);
  const distance = target - BigInt(run.nextBlock);
  return Object.freeze({
    barrierDistance: (distance > 0n ? distance : 0n).toString(),
    liveLagBlocks: (liveLag > 0n ? liveLag : 0n).toString(),
  });
}
async function advanceRun(runtime, options, run, context) {
  if (run.status === 'scanning') {
    try {
      return await runtime.lifecycle.attachToLive({
        runId: run.id, version: run.version, attachWindow: options.attachWindow,
      });
    } catch (error) {
      if (!['holder_global_backfill_attach_unavailable',
        'holder_global_backfill_live_cursor_unavailable'].includes(error.code)) throw error;
      return runtime.scanner.runOnce({ liveLagBlocks: context.liveLagBlocks ?? 0 });
    }
  }
  if (run.status === 'attached') {
    const scanned = await runtime.scanner.runOnce({ liveLagBlocks: context.liveLagBlocks ?? 0 });
    return scanned.status === 'caught-up'
      ? runtime.materializer.materializeOnce({
        finalityBlocks: options.finalityBlocks, limit: options.materializeBatchSize,
      }) : scanned;
  }
  if (run.status === 'materializing') {
    const materialized = await runtime.materializer.materializeOnce({
      finalityBlocks: options.finalityBlocks, limit: options.materializeBatchSize,
    });
    if (materialized.status !== 'idle') return materialized;
    const handedOff = await runtime.materializer.handoffOnce({
      finalityBlocks: options.finalityBlocks, limit: options.materializeBatchSize,
    });
    return handedOff.status === 'idle'
      ? runtime.lifecycle.syncCompletion({ runId: run.id }) : handedOff;
  }
  return Object.freeze({ status: run.status, runId: run.id });
}
async function runCampaignTick(runtime, options) {
  let run = await runtime.lifecycle.getLatestRun();
  if (!run) {
    run = await runtime.lifecycle.createRun({ catalogCutoff: options.catalogCutoff });
    return Object.freeze({ status: 'frozen-preview', runId: run.id, cohortTokens: run.cohortTokenCount });
  }
  if (run.status === 'completed') {
    if (!options.rollingEnabled) return Object.freeze({ status: 'completed', runId: run.id });
    const catalogCutoff = new Date(Date.now() - options.rollingDelayMs).toISOString();
    const candidateInput = {
      catalogCutoff, includeBackfilling: false,
      minimumGapBlocks: options.rollingMinGapBlocks,
    };
    const preview = await runtime.delta.previewRun(candidateInput);
    if ((preview?.candidateTokens || 0) < options.rollingMinTokens) {
      return Object.freeze({
        status: 'rolling-idle', candidateTokens: preview?.candidateTokens || 0,
        minimumTokens: options.rollingMinTokens, catalogCutoff,
      });
    }
    const created = await runtime.delta.createRun(candidateInput);
    return Object.freeze({
      status: 'frozen-preview', runId: created.runId,
      cohortTokens: created.cohortTokens, catalogCutoff,
    });
  }
  if (run.status === 'frozen') {
    if (!options.autoStart) return Object.freeze({
      status: 'frozen-preview', runId: run.id, cohortTokens: run.cohortTokenCount,
    });
    const started = await runtime.lifecycle.startRun({ runId: run.id, version: run.version });
    return Object.freeze({ status: 'scanning', runId: run.id, nextBlock: started.nextBlock });
  }
  if (run.status === 'paused') return Object.freeze({ status: 'paused', runId: run.id });
  const context = await liveContext(runtime, options, run);
  const result = await advanceRun(runtime, options, run, context);
  run = await runtime.lifecycle.getLatestRun();
  const elapsedSeconds = Math.max(1, (Date.now() - new Date(run.createdAt).getTime()) / 1000);
  const startBlock = BigInt(run.telemetry?.startBlock ?? 0);
  const scannedBlocks = BigInt(run.nextBlock) - startBlock;
  const blocksPerSecond = Number(scannedBlocks > 0n ? scannedBlocks : 0n) / elapsedSeconds;
  const telemetry = Object.freeze({
    phase: run.status, startBlock: startBlock.toString(),
    nextBlock: run.nextBlock, barrierBlock: run.barrierBlock,
    ...context, blocksPerSecond: Number(blocksPerSecond.toFixed(3)),
    etaSeconds: blocksPerSecond > 0 && context.barrierDistance != null
      ? Math.ceil(Number(context.barrierDistance) / blocksPerSecond) : null,
    lastAction: result.status, scanner: runtime.scanner.getStatus(),
  });
  await runtime.lifecycle.recordTelemetry({ runId: run.id, telemetry });
  return Object.freeze({ ...result, runId: run.id, telemetry });
}
function publicError(error) {
  return Object.freeze({
    code: error.code || 'holder_global_backfill_error',
    message: String(error.message || error).slice(0, 500), at: new Date().toISOString(),
  });
}
function createRobinhoodHolderGlobalBackfillWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const runtimeFactory = deps.runtimeFactory || ((options) => buildRuntime(options, deps));
  let options = normalizeOptions();
  let runtimePromise;
  let timer;
  let activeRun;
  let running = false;
  let onFatal;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    providerName: null, totalRuns: 0, totalErrors: 0, consecutiveErrors: 0,
    lastResult: null, lastError: null, lastCompletedAt: null,
  };
  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    try {
      runtimePromise ||= Promise.resolve(runtimeFactory(options));
      const runtime = await runtimePromise;
      status.providerName = runtime.providerName;
      const result = await runCampaignTick(runtime, options);
      status.lastResult = result; status.lastError = null; status.consecutiveErrors = 0;
      if (result.status === 'checkpoint-diverged') {
        throw Object.assign(new Error('global holder barrier checkpoint diverged'), {
          code: 'holder_global_backfill_checkpoint_diverged', fatal: true,
        });
      }
      return result;
    } catch (error) {
      status.totalErrors += 1; status.consecutiveErrors += 1; status.lastError = publicError(error);
      if (error.fatal || error.code === 'configuration_error') {
        running = false; status.running = false; status.halted = true;
        if (timer) cancelSchedule(timer);
        timer = null;
        try { await onFatal?.(error); } catch (fatalError) {
          logger.error('[RobinhoodHolderGlobalBackfillWorker] Fatal propagation failed:', fatalError.message);
        }
      } else logger.warn('[RobinhoodHolderGlobalBackfillWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false; status.lastCompletedAt = new Date().toISOString();
    }
  }
  function runOnce() {
    if (activeRun) return activeRun;
    activeRun = execute().finally(() => { activeRun = null; });
    return activeRun;
  }
  function queue(delayMs) {
    if (!running || status.halted) return;
    timer = schedule(async () => {
      await runOnce();
      const delay = status.consecutiveErrors
        ? Math.min(options.maxErrorBackoffMs, options.intervalMs * (2 ** status.consecutiveErrors))
        : status.lastResult?.status === 'rolling-idle'
          ? options.rollingCheckIntervalMs : options.intervalMs;
      queue(delay);
    }, delayMs);
    timer?.unref?.();
  }
  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input); onFatal = input.onFatal;
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    status.halted = false; running = true; status.running = true; queue(0);
    return true;
  }
  async function stop() {
    running = false; status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => {});
  }
  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}
const worker = createRobinhoodHolderGlobalBackfillWorker();
module.exports = {
  createRobinhoodHolderGlobalBackfillWorker,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: { advanceRun, buildRuntime, liveContext, normalizeOptions, runCampaignTick },
};
