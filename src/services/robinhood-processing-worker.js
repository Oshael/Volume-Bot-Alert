/**
 * robinhood-processing worker (Corte 4d).
 *
 * Wraps the processing runner in the singleton start/stop/getStatus lifecycle the
 * other Robinhood workers use, ticking the claim→decode→persist→settle loop and
 * pruning the capture queue on a slower cadence once its retention window
 * elapses. It composes its own persistence and processing repositories; it never
 * touches the capture cursor.
 */
const db = require('../models/db');
const { CURSOR_NOTIFY_CHANNEL } = require('../models/robinhood-head-capture');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createRobinhoodHeadProcessingRepository } = require('../models/robinhood-head-processing');
const {
  createRobinhoodProcessingRunner, normalizeProcessingBatchSize,
} = require('./robinhood-processing-runner');
const {
  createRobinhoodDiscoveryProcessingRunner,
} = require('./robinhood-discovery-processing-runner');
const {
  createRobinhoodProcessingShadowAuditor,
} = require('./robinhood-processing-shadow-auditor');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = CURSOR_NOTIFY_CHANNEL;
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_IDLE_INTERVAL_MS = 5000;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;
let running = false;
let ticking = false;
let stopping = false;
let activeTick = null;
let wakePending = false;
let pendingWakeAtMs = null;
let runner = null;
let discoveryRunner = null;
let repository = null;
let listener = null;
let activeOptions = null;
let lastPruneAt = 0;
let status = {
  running: false,
  enabled: true,
  lastTickAt: null,
  lastClaimed: 0,
  lastProcessed: 0,
  lastRejected: 0,
  lastRetried: 0,
  lastBlocked: 0,
  lastReclaimed: 0,
  lastV4ContinuationRounds: 0,
  lastV4ContinuationClaimed: 0,
  lastV4ContinuationPools: 0,
  lastTiming: null,
  totalProcessed: 0,
  totalRejected: 0,
  totalBlocked: 0,
  totalPrunedCaptures: 0,
  totalErrors: 0,
  totalWakes: 0,
  fallbackChecks: 0,
  fallbackRuns: 0,
  lastWakeAt: null,
  lastWakeStream: null,
  lastProgressAt: null,
  lastFallbackAt: null,
  wakeToClaimMs: null,
  lastShadowAudit: null,
  totalShadowCompared: 0,
  totalShadowMatched: 0,
  totalShadowMismatched: 0,
  totalShadowMissing: 0,
  totalShadowErrors: 0,
  lastPrunedAt: null,
  lastPrunedCaptures: 0,
  lastError: null,
};

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled !== false,
    intervalMs: boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 100, 60_000),
    idleIntervalMs: boundedInteger(options.idleIntervalMs, DEFAULT_IDLE_INTERVAL_MS, 100, 300_000),
    pruneIntervalMs: boundedInteger(options.pruneIntervalMs, DEFAULT_PRUNE_INTERVAL_MS, 30_000, 3_600_000),
    runner: {
      owner: options.owner,
      batchSize: normalizeProcessingBatchSize(options.batchSize),
      leaseMs: options.leaseMs,
      retentionMs: options.retentionMs,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
      v4ContinuationRounds: boundedInteger(options.v4ContinuationRounds, 8, 0, 100),
      v4ContinuationPoolLimit: boundedInteger(options.v4ContinuationPoolLimit, 8, 1, 64),
      v4SwapPrefixLimit: boundedInteger(options.v4SwapPrefixLimit, 512, 1, 2000),
      emitOutbox: options.emitOutbox,
    },
    pruneLimit: boundedInteger(options.pruneLimit, 5000, 100, 50_000),
    shadowAuditEnabled: options.shadowAuditEnabled === true,
    shadowAuditSampleLimit: boundedInteger(options.shadowAuditSampleLimit, 5, 1, 20),
    shadowAuditStatementTimeoutMs: boundedInteger(
      options.shadowAuditStatementTimeoutMs, 1000, 100, 10_000
    ),
  };
}

function build(normalized, deps = {}) {
  stopping = false;
  const database = deps.database || db;
  repository = deps.repository || createRobinhoodHeadProcessingRepository({ database });
  const persistence = deps.persistence || createRobinhoodPersistenceRepository({ database });
  const shadowAuditor = deps.shadowAuditor || (normalized.shadowAuditEnabled
    ? createRobinhoodProcessingShadowAuditor({
      database,
      sampleLimit: normalized.shadowAuditSampleLimit,
      statementTimeoutMs: normalized.shadowAuditStatementTimeoutMs,
    })
    : null);
  runner = deps.runner || createRobinhoodProcessingRunner({
    repository, persistence, shadowAuditor, options: normalized.runner,
    shouldContinue: () => !stopping,
  });
  // Co-located discovery consumer (same process/lease group). It shares the head
  // processing repository and drains stream='discovery' into the pool registry.
  // A distinct lease owner keeps its settlements from matching the market runner's
  // rows; reclaim stays off because the market runner's chain-wide reclaim covers
  // abandoned discovery leases too.
  discoveryRunner = deps.discoveryRunner || createRobinhoodDiscoveryProcessingRunner({
    repository,
    persistence,
    options: {
      ...normalized.runner,
      // Enlarging market claims must not enlarge the co-located discovery batch.
      batchSize: Math.min(normalized.runner.batchSize, 2000),
      owner: normalized.runner.owner ? `${normalized.runner.owner}:discovery` : undefined,
      emitOutbox: undefined,
    },
  });
}

async function maybePrune(normalized, nowMs) {
  if (nowMs - lastPruneAt < normalized.pruneIntervalMs) return;
  lastPruneAt = nowMs;
  const pruned = await repository.pruneExpiredCaptures({ limit: normalized.pruneLimit });
  status.lastPrunedAt = new Date(nowMs).toISOString();
  status.lastPrunedCaptures = pruned;
  status.totalPrunedCaptures += pruned;
}

async function runDiscoveryOnce() {
  if (stopping) {
    return { claimed: 0, processed: 0, rejected: 0, retried: 0, blocked: 0 };
  }
  const discovery = await discoveryRunner.runOnce();
  const previous = status.discovery || {};
  status.discovery = {
    lastTickAt: new Date().toISOString(),
    lastClaimed: discovery.claimed,
    lastProcessed: discovery.processed,
    lastRejected: discovery.rejected,
    lastRetried: discovery.retried,
    lastBlocked: discovery.blocked,
    totalProcessed: (previous.totalProcessed || 0) + discovery.processed,
    totalRejected: (previous.totalRejected || 0) + discovery.rejected,
    totalBlocked: (previous.totalBlocked || 0) + discovery.blocked,
  };
  return discovery;
}

async function runOnce(normalized, trigger = {}) {
  if (Number.isFinite(trigger.wakeAtMs)) {
    status.wakeToClaimMs = Math.max(0, Date.now() - trigger.wakeAtMs);
  }
  const result = await runner.runOnce();
  status.lastTickAt = new Date().toISOString();
  status.lastClaimed = result.claimed;
  status.lastProcessed = result.processed;
  status.lastRejected = result.rejected;
  status.lastRetried = result.retried;
  status.lastBlocked = result.blocked;
  status.lastReclaimed = result.reclaimed;
  status.lastV4ContinuationRounds = result.continuationRounds || 0;
  status.lastV4ContinuationClaimed = result.continuationClaimed || 0;
  status.lastV4ContinuationPools = result.continuationPools || 0;
  status.lastTiming = result.timing || null;
  status.totalProcessed += result.processed;
  status.totalRejected += result.rejected;
  status.totalBlocked += result.blocked;
  if (result.shadowAudit) {
    status.lastShadowAudit = result.shadowAudit;
    status.totalShadowCompared += result.shadowAudit.compared || 0;
    status.totalShadowMatched += result.shadowAudit.matched || 0;
    status.totalShadowMismatched += result.shadowAudit.mismatched || 0;
    status.totalShadowMissing += result.shadowAudit.missing || 0;
    status.totalShadowErrors += result.shadowAudit.errors || 0;
  }
  const discovery = await runDiscoveryOnce();
  await maybePrune(normalized, Date.now());
  // Keep the tick loop hot while either stream still has claimable work.
  const combined = { ...result, claimed: result.claimed + discovery.claimed };
  if (combined.claimed > 0) status.lastProgressAt = new Date().toISOString();
  return combined;
}

async function executeScheduledTick(normalized, trigger) {
  ticking = true;
  let nextDelay = normalized.intervalMs;
  let nextKind = 'fallback';
  try {
    if (trigger.kind === 'fallback') status.fallbackChecks += 1;
    const result = await runOnce(normalized, trigger);
    status.lastError = null;
    if (trigger.kind === 'fallback' && result.claimed > 0) {
      status.fallbackRuns += 1;
      status.lastFallbackAt = new Date().toISOString();
    }
  } catch (error) {
    status.totalErrors += 1;
    status.lastError = String(error?.message || error).slice(0, 1000);
    console.error('[RobinhoodProcessingWorker] Tick failed:', status.lastError);
    nextDelay = normalized.idleIntervalMs;
    nextKind = 'error-backoff';
  } finally {
    ticking = false;
    if (wakePending) {
      const wakeAtMs = pendingWakeAtMs;
      wakePending = false;
      pendingWakeAtMs = null;
      schedule(normalized, 0, { kind: 'wake', wakeAtMs });
    } else {
      schedule(normalized, nextDelay, { kind: nextKind });
    }
  }
}

function schedule(normalized, delayMs, trigger = { kind: 'fallback' }) {
  if (!running) return;
  timer = setTimeout(() => {
    timer = null;
    const tick = executeScheduledTick(normalized, trigger);
    activeTick = tick;
    void tick.finally(() => {
      if (activeTick === tick) activeTick = null;
    });
  }, delayMs);
  timer?.unref?.();
}

function wake(wakeAtMs = Date.now()) {
  if (!running) return;
  if (ticking) {
    wakePending = true;
    pendingWakeAtMs = pendingWakeAtMs == null
      ? wakeAtMs : Math.min(pendingWakeAtMs, wakeAtMs);
    return;
  }
  if (timer) clearTimeout(timer);
  timer = null;
  schedule(activeOptions, 0, { kind: 'wake', wakeAtMs });
}

function handleNotification(message) {
  if (message?.channel !== NOTIFY_CHANNEL) return;
  const wakeAtMs = Date.now();
  status.lastWakeAt = new Date(wakeAtMs).toISOString();
  status.lastWakeStream = ['market', 'discovery'].includes(message.payload)
    ? message.payload : null;
  status.totalWakes += 1;
  wake(wakeAtMs);
}

function start(options = {}, deps = {}) {
  if (running) return;
  const normalized = normalizeOptions(options);
  if (!normalized.enabled) return;
  build(normalized, deps);
  activeOptions = normalized;
  running = true;
  status.running = true;
  status.enabled = true;
  lastPruneAt = 0;
  const listenerFactory = deps.listenerFactory || createPostgresRealtimeListener;
  listener = listenerFactory({
    channel: NOTIFY_CHANNEL,
    label: 'RobinhoodProcessingWorker',
    pool: deps.pool || db.pool,
    onNotification: handleNotification,
  });
  // Arm recovery first so a notification arriving immediately after LISTEN
  // replaces this timer instead of creating a concurrent startup tick.
  schedule(normalized, 0, { kind: 'startup' });
  Promise.resolve(listener.start()).catch((error) => {
    status.lastError = `listener: ${String(error?.message || error).slice(0, 200)}`;
  });
}

async function stop() {
  stopping = true;
  running = false;
  status.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  wakePending = false;
  pendingWakeAtMs = null;
  activeOptions = null;
  const tick = activeTick;
  if (tick) await tick;
  const current = listener;
  listener = null;
  if (current) await Promise.resolve(current.stop()).catch(() => {});
}

function getStatus() {
  const listenerStatus = listener?.getStatus?.() || null;
  const listenerState = !running ? 'stopped'
    : listenerStatus?.listening ? 'listening'
      : listenerStatus?.reconnectScheduled ? 'reconnecting' : 'connecting';
  return { ...status, listenerState, listener: listenerStatus };
}

module.exports = {
  NOTIFY_CHANNEL,
  DEFAULT_INTERVAL_MS,
  getStatus,
  runOnce,
  start,
  stop,
  __private: { normalizeOptions, build, handleNotification, wake },
};
