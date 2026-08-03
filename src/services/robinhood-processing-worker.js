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
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createRobinhoodHeadProcessingRepository } = require('../models/robinhood-head-processing');
const { createRobinhoodProcessingRunner } = require('./robinhood-processing-runner');

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_IDLE_INTERVAL_MS = 5000;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;
let running = false;
let runner = null;
let repository = null;
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
  totalProcessed: 0,
  totalRejected: 0,
  totalBlocked: 0,
  totalPrunedCaptures: 0,
  totalErrors: 0,
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
      batchSize: options.batchSize,
      leaseMs: options.leaseMs,
      retentionMs: options.retentionMs,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    },
    pruneLimit: boundedInteger(options.pruneLimit, 5000, 100, 50_000),
  };
}

function build(normalized, deps = {}) {
  const database = deps.database || db;
  repository = deps.repository || createRobinhoodHeadProcessingRepository({ database });
  const persistence = deps.persistence || createRobinhoodPersistenceRepository({ database });
  runner = deps.runner || createRobinhoodProcessingRunner({
    repository, persistence, options: normalized.runner,
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

async function runOnce(normalized) {
  const result = await runner.runOnce();
  status.lastTickAt = new Date().toISOString();
  status.lastClaimed = result.claimed;
  status.lastProcessed = result.processed;
  status.lastRejected = result.rejected;
  status.lastRetried = result.retried;
  status.lastBlocked = result.blocked;
  status.lastReclaimed = result.reclaimed;
  status.totalProcessed += result.processed;
  status.totalRejected += result.rejected;
  status.totalBlocked += result.blocked;
  await maybePrune(normalized, Date.now());
  return result;
}

function schedule(normalized, delayMs) {
  if (!running) return;
  timer = setTimeout(async () => {
    let nextDelay = normalized.intervalMs;
    try {
      const result = await runOnce(normalized);
      status.lastError = null;
      if (!result.claimed) nextDelay = normalized.idleIntervalMs;
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = String(error?.message || error).slice(0, 1000);
      console.error('[RobinhoodProcessingWorker] Tick failed:', status.lastError);
      nextDelay = normalized.idleIntervalMs;
    } finally {
      schedule(normalized, nextDelay);
    }
  }, delayMs);
}

function start(options = {}, deps = {}) {
  if (running) return;
  const normalized = normalizeOptions(options);
  if (!normalized.enabled) return;
  build(normalized, deps);
  running = true;
  status.running = true;
  status.enabled = true;
  lastPruneAt = 0;
  schedule(normalized, 0);
}

function stop() {
  running = false;
  status.running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function getStatus() {
  return { ...status };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  getStatus,
  runOnce,
  start,
  stop,
  __private: { normalizeOptions, build },
};
