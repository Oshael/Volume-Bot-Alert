const db = require('../models/db');
const { createRobinhoodHolderLedgerRepository } = require('../models/robinhood-holder-ledger');
const {
  NOTIFY_CHANNEL: REALTIME_OUTBOX_CHANNEL,
  createRobinhoodHolderRealtimeOutboxRepository,
} = require('../models/robinhood-holder-realtime-outbox');
const holderCountRealtime = require('./robinhood-holder-count-realtime');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { createRobinhoodDerivedRunner } = require('./robinhood-derived-runner');
const { createRobinhoodHolderLiveRunner } = require('./robinhood-holder-live-runner');
const {
  normalizeRobinhoodHolderLiveSource,
  resolveRobinhoodHolderLiveSource,
} = require('./robinhood-holder-live-source');

const FATAL_CODES = new Set(['configuration_error', 'holder_live_apply_contract_error']);
const HOT_QUEUE_CHANNEL = 'robinhood_holder_hot_queue';
const REALTIME_BATCH_SIZE = 500;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value == null ? fallback : Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeOptions(options = {}, env = process.env) {
  return Object.freeze({
    enabled: options.enabled === true,
    sourceMode: normalizeRobinhoodHolderLiveSource(
      options.sourceMode ?? env.ROBINHOOD_HOLDER_LIVE_SOURCE
    ),
    intervalMs: boundedInteger(options.intervalMs, 100, 50, 300_000),
    maxErrorBackoffMs: boundedInteger(options.maxErrorBackoffMs, 30_000, 1000, 300_000),
    concurrency: boundedInteger(options.concurrency, 1, 1, 8),
    maxApplyEvents: boundedInteger(options.maxApplyEvents, 5000, 1, 50_000),
    shadowPromotionBatchSize: boundedInteger(
      options.shadowPromotionBatchSize, 250, 1, 1000
    ),
    applyBatchSize: boundedInteger(options.applyBatchSize, 100, 1, 1000),
    hotApplyBatchSize: boundedInteger(options.hotApplyBatchSize, 25, 1, 100),
    maxDurationMs: boundedInteger(options.maxDurationMs, 2000, 250, 60_000),
    rpcTimeoutMs: boundedInteger(
      options.rpcTimeoutMs ?? env.ROBINHOOD_RPC_TIMEOUT_MS, 15_000, 1000, 60_000
    ),
  });
}

async function buildRuntime(options, deps = {}) {
  const database = deps.database || db;
  const source = await resolveRobinhoodHolderLiveSource({
    sourceMode: options.sourceMode,
    providerName: 'robinhood-holder-live-apply',
    rpcTimeoutMs: options.rpcTimeoutMs,
  }, { ...deps, database });
  const ledger = deps.ledger || (deps.ledgerFactory || createRobinhoodHolderLedgerRepository)({
    database,
  });
  const { reader } = source;
  const realtimeOutbox = deps.realtimeOutbox
    || createRobinhoodHolderRealtimeOutboxRepository({ database });
  const publishHolderCounts = deps.publishHolderCounts || holderCountRealtime.publishUpdates;
  const publisher = deps.publisher || createRobinhoodDerivedRunner({
    repository: realtimeOutbox,
    fanout: async (payload) => {
      if (await publishHolderCounts([payload]) !== 1) {
        throw new Error('holder realtime relay rejected the durable event');
      }
    },
    options: { owner: `robinhood-holder-realtime:${process.pid}`, batchSize: REALTIME_BATCH_SIZE },
  });
  const runner = deps.runner || (deps.runnerFactory || createRobinhoodHolderLiveRunner)({
    ledger, reader, publishHolderCounts: async () => 0,
  });
  return Object.freeze({
    sourceMode: source.sourceMode, providerName: source.providerName,
    runner, publisher, realtimeOutbox,
  });
}

function publicError(error) {
  if (!error) return null;
  const optionalText = (value, limit = 500) => {
    if (value == null || value === '') return null;
    return String(value).slice(0, limit);
  };
  const postgres = Object.fromEntries([
    ['severity', optionalText(error.severity, 32)],
    ['detail', optionalText(error.detail)],
    ['schema', optionalText(error.schema, 128)],
    ['table', optionalText(error.table, 128)],
    ['column', optionalText(error.column, 128)],
    ['constraint', optionalText(error.constraint, 128)],
    ['dataType', optionalText(error.dataType, 128)],
    ['routine', optionalText(error.routine, 128)],
  ].filter(([, value]) => value !== null));
  const stage = optionalText(error.holderStage, 64);
  const tokenAddress = optionalText(error.holderTokenAddress, 42);
  return Object.freeze({
    code: error.code || 'holder_live_apply_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
    ...(stage ? { stage } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(Object.keys(postgres).length ? { postgres: Object.freeze(postgres) } : {}),
  });
}

function createRobinhoodHolderLiveApplyWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const runtimeFactory = deps.runtimeFactory || ((options) => buildRuntime(options, deps));
  let options = normalizeOptions({}, env);
  let runtimePromise = null;
  let timer = null;
  let activeRunPromise = null;
  let listeners = [];
  let wakePending = false;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    sourceMode: null, providerName: null, lastResult: null, lastError: null,
    totalRuns: 0, totalErrors: 0, consecutiveErrors: 0,
    totalAppliedEvents: 0, totalDriftedTokens: 0, totalDriftSuspicions: 0,
    totalReceiptRecoveries: 0, totalTailRollbacks: 0, totalTailRollbackEvents: 0,
    totalBaselineRequeues: 0,
    totalQuarantinedTokens: 0,
    totalShadowPromotions: 0,
    totalHolderCountUpdates: 0, totalHolderCountPublished: 0, lastCompletedAt: null,
    totalWakeups: 0, totalFinalized: 0, totalInvalidated: 0, listenerError: null,
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
    await Promise.all(listeners.map((listener) => listener.stop().catch(() => {})));
    listeners = [];
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodHolderLiveApplyWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    try {
      const runtime = await getRuntime();
      status.sourceMode = runtime.sourceMode;
      status.providerName = runtime.providerName;
      const lifecycle = runtime.realtimeOutbox ? await runtime.realtimeOutbox.promoteFinalized({
        limit: REALTIME_BATCH_SIZE,
      }) : null;
      const publication = runtime.publisher ? await runtime.publisher.runOnce() : null;
      const backlog = runtime.realtimeOutbox ? await runtime.realtimeOutbox.readBacklog() : null;
      const applied = await runtime.runner.applyOnce(options);
      const result = lifecycle || publication || backlog
        ? { ...applied, realtime: { lifecycle, publication, backlog } } : applied;
      status.lastResult = result; status.lastError = null; status.consecutiveErrors = 0;
      status.totalAppliedEvents += finiteNumber(applied.appliedEvents);
      status.totalDriftedTokens += finiteNumber(applied.driftedTokens);
      status.totalDriftSuspicions += finiteNumber(applied.driftSuspicions);
      status.totalReceiptRecoveries += finiteNumber(applied.receiptRecoveries);
      status.totalTailRollbacks += finiteNumber(applied.tailRollbacks);
      status.totalTailRollbackEvents += finiteNumber(applied.tailRollbackEvents);
      status.totalBaselineRequeues += finiteNumber(applied.baselineRequeues);
      status.totalQuarantinedTokens += finiteNumber(applied.quarantinedTokens);
      status.totalShadowPromotions += finiteNumber(applied.shadowPromotions);
      status.totalHolderCountUpdates += finiteNumber(applied.holderCountUpdates);
      status.totalHolderCountPublished += finiteNumber(
        publication ? publication.delivered : applied.holderCountPublished
      );
      status.totalFinalized += finiteNumber(lifecycle?.finalized);
      status.totalInvalidated += finiteNumber(lifecycle?.invalidated);
      return result;
    } catch (error) {
      status.totalErrors += 1; status.consecutiveErrors += 1;
      status.lastError = publicError(error);
      if (error.fatal === true || FATAL_CODES.has(error.code)) await halt(error);
      else logger.warn('[RobinhoodHolderLiveApplyWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false; status.lastCompletedAt = new Date().toISOString();
    }
  }

  function runOnce() {
    if (activeRunPromise) return activeRunPromise;
    activeRunPromise = execute().finally(() => { activeRunPromise = null; });
    return activeRunPromise;
  }

  function queueNext(delayMs) {
    if (!running || status.halted) return;
    timer = schedule(async () => {
      timer = null;
      await runOnce();
      const delay = wakePending ? 0 : status.consecutiveErrors
        ? Math.min(options.maxErrorBackoffMs,
          options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8)))
        : options.intervalMs;
      wakePending = false;
      queueNext(delay);
    }, delayMs);
    timer?.unref?.();
  }

  function wake() {
    if (!running || status.halted) return;
    status.totalWakeups += 1;
    if (activeRunPromise) {
      wakePending = true;
      return;
    }
    if (timer) cancelSchedule(timer);
    timer = null;
    queueNext(0);
  }

  function startListeners() {
    const factory = deps.listenerFactory || createPostgresRealtimeListener;
    listeners = [
      [HOT_QUEUE_CHANNEL, 'RobinhoodHolderHotQueueListener'],
      [REALTIME_OUTBOX_CHANNEL, 'RobinhoodHolderRealtimeOutboxListener'],
    ].map(([channel, label]) => factory({
      channel, label, pool: (deps.database || db).pool, logger,
      onNotification: wake, onConnected: () => { status.listenerError = null; },
    }));
    for (const listener of listeners) void listener.start().catch((error) => {
      status.listenerError = publicError(error);
      logger.warn('[RobinhoodHolderLiveApplyWorker] Listener unavailable:', error.message);
    });
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input, env);
    onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    status.halted = false; wakePending = false; running = true; status.running = true;
    startListeners(); queueNext(0);
    return true;
  }

  async function stop() {
    running = false; status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRunPromise) await activeRunPromise.catch(() => {});
    await Promise.all(listeners.map((listener) => listener.stop().catch(() => {})));
    listeners = [];
  }

  return Object.freeze({
    getStatus: () => ({
      ...status, listeners: listeners.map((listener) => listener.getStatus?.() || null),
    }),
    runOnce, start, stop,
  });
}

const worker = createRobinhoodHolderLiveApplyWorker();
module.exports = {
  REALTIME_BATCH_SIZE,
  createRobinhoodHolderLiveApplyWorker,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, normalizeOptions },
};
