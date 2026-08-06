/**
 * robinhood-derived worker (Corte 5, slice 4c).
 *
 * Wraps the derived runner in the singleton start/stop/getStatus lifecycle the
 * other Robinhood workers use, draining the derived outbox and replaying the
 * shared market:bucket fan-out. A LISTEN/NOTIFY wake ticks immediately when the
 * producer signals new rows; otherwise it polls at the idle cadence. Blocked
 * dead-letters are pruned on a slower cadence. It owns no cursor and never
 * touches capture or processing: a derived failure isolates its own outbox row.
 */
const db = require('../models/db');
const {
  createRobinhoodDerivedOutboxRepository,
  OUTBOX_NOTIFY_CHANNEL,
} = require('../models/robinhood-derived-outbox');
const { createRobinhoodDerivedRunner } = require('./robinhood-derived-runner');
const { createRobinhoodDerivedShadowAuditor } = require('./robinhood-derived-shadow-auditor');
const { createRobinhoodMarketBucketFanout } = require('./robinhood-market-bucket-fanout');
const marketBucketRealtime = require('./market-bucket-realtime');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = OUTBOX_NOTIFY_CHANNEL;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_IDLE_INTERVAL_MS = 2000;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;
let running = false;
let ticking = false;
let wakePending = false;
let runner = null;
let repository = null;
let listener = null;
let shadowAuditor = null;
let activeOptions = null;
let lastPruneAt = 0;
let status = {
  running: false,
  enabled: true,
  lastTickAt: null,
  lastClaimed: 0,
  lastDelivered: 0,
  lastRetried: 0,
  lastBlocked: 0,
  lastReclaimed: 0,
  totalDelivered: 0,
  totalBlocked: 0,
  totalPrunedRows: 0,
  totalNotifies: 0,
  totalErrors: 0,
  lastNotifyAt: null,
  lastPrunedAt: null,
  lastPrunedRows: 0,
  lastError: null,
  mode: 'delivery',
};

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled !== false,
    shadowAuditOnly: options.shadowAuditOnly === true,
    shadowAuditSampleLimit: boundedInteger(options.shadowAuditSampleLimit, 5, 1, 20),
    shadowAuditStatementTimeoutMs: boundedInteger(
      options.shadowAuditStatementTimeoutMs, 1000, 100, 10_000
    ),
    intervalMs: boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 50, 60_000),
    idleIntervalMs: boundedInteger(options.idleIntervalMs, DEFAULT_IDLE_INTERVAL_MS, 100, 300_000),
    pruneIntervalMs: boundedInteger(options.pruneIntervalMs, DEFAULT_PRUNE_INTERVAL_MS, 30_000, 3_600_000),
    runner: {
      owner: options.owner,
      batchSize: options.batchSize,
      leaseMs: options.leaseMs,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    },
    pruneLimit: boundedInteger(options.pruneLimit, 5000, 100, 50_000),
    pruneOlderThanMs: boundedInteger(options.pruneOlderThanMs, 86_400_000, 60_000, 604_800_000),
  };
}

function build(normalized, deps = {}) {
  const database = deps.database || db;
  repository = deps.repository || createRobinhoodDerivedOutboxRepository({ database });
  shadowAuditor = normalized.shadowAuditOnly
    ? (deps.shadowAuditor || createRobinhoodDerivedShadowAuditor({
      database,
      sampleLimit: normalized.shadowAuditSampleLimit,
      statementTimeoutMs: normalized.shadowAuditStatementTimeoutMs,
    }))
    : null;
  const relay = deps.marketBucketRealtime || marketBucketRealtime;
  const deliveryFanout = deps.fanout || createRobinhoodMarketBucketFanout({
    // The generic monolith path remains enqueue/coalesce. Derived delivery must
    // await the actual pg_notify before its durable outbox row is deleted.
    marketBucketRealtime: { enqueue: (payload) => relay.publish(payload) },
  });
  const fanout = shadowAuditor
    ? (payload) => shadowAuditor.consume(payload)
    : deliveryFanout;
  status.mode = shadowAuditor ? 'shadow-audit-only' : 'delivery';
  runner = deps.runner || createRobinhoodDerivedRunner({
    repository, fanout, options: normalized.runner,
  });
}

async function maybePrune(normalized, nowMs) {
  if (nowMs - lastPruneAt < normalized.pruneIntervalMs) return;
  lastPruneAt = nowMs;
  const pruned = await repository.pruneBlocked({
    limit: normalized.pruneLimit, olderThanMs: normalized.pruneOlderThanMs,
  });
  status.lastPrunedAt = new Date(nowMs).toISOString();
  status.lastPrunedRows = pruned;
  status.totalPrunedRows += pruned;
}

async function runOnce(normalized) {
  const result = await runner.runOnce();
  status.lastTickAt = new Date().toISOString();
  status.lastClaimed = result.claimed;
  status.lastDelivered = result.delivered;
  status.lastRetried = result.retried;
  status.lastBlocked = result.blocked;
  status.lastReclaimed = result.reclaimed;
  status.totalDelivered += result.delivered;
  status.totalBlocked += result.blocked;
  await maybePrune(normalized, Date.now());
  return result;
}

function schedule(delayMs) {
  if (!running) return;
  timer = setTimeout(async () => {
    timer = null;
    ticking = true;
    let nextDelay = activeOptions.intervalMs;
    try {
      const result = await runOnce(activeOptions);
      status.lastError = null;
      if (!result.claimed && !wakePending) nextDelay = activeOptions.idleIntervalMs;
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = String(error?.message || error).slice(0, 1000);
      console.error('[RobinhoodDerivedWorker] Tick failed:', status.lastError);
      nextDelay = activeOptions.idleIntervalMs;
    } finally {
      ticking = false;
      if (wakePending) { wakePending = false; nextDelay = 0; }
      schedule(nextDelay);
    }
  }, delayMs);
  timer?.unref?.();
}

// A producer NOTIFY jumps the queue: run now if idle, or mark the in-flight tick
// to re-run immediately so a burst never waits out the idle interval.
function wake() {
  if (!running) return;
  if (ticking) { wakePending = true; return; }
  if (timer) clearTimeout(timer);
  timer = null;
  schedule(0);
}

function handleNotification(message) {
  if (message?.channel !== NOTIFY_CHANNEL) return;
  status.lastNotifyAt = new Date().toISOString();
  status.totalNotifies += 1;
  wake();
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
    label: 'RobinhoodDerivedWorker',
    pool: deps.pool || db.pool,
    onNotification: handleNotification,
  });
  Promise.resolve(listener.start()).catch((error) => {
    status.lastError = `listener: ${String(error?.message || error).slice(0, 200)}`;
  });
  schedule(0);
}

async function stop() {
  running = false;
  status.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  const current = listener;
  listener = null;
  if (current) await Promise.resolve(current.stop()).catch(() => {});
}

function getStatus() {
  return { ...status, shadowAudit: shadowAuditor?.getStatus?.() || null };
}

module.exports = {
  NOTIFY_CHANNEL,
  DEFAULT_INTERVAL_MS,
  getStatus,
  runOnce,
  start,
  stop,
  __private: { normalizeOptions, build, handleNotification },
};
