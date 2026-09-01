const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const {
  createRobinhoodBundleRedistributionLiveQueueRepository,
} = require('../models/robinhood-bundle-redistribution-live-queue');
const {
  createRobinhoodBundleRedistributionLiveSource,
} = require('../models/robinhood-bundle-redistribution-live-source');
const {
  EVIDENCE_VERSION, POLICY, RULE_VERSION, evaluateBundleRedistribution,
} = require('./robinhood-bundle-redistribution-policy');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { NOTIFY_CHANNEL } = require('../utils/db-init-stage188');

const bounded = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};
const normalizeOptions = (input = {}) => Object.freeze({
  enabled: input.enabled === true,
  intervalMs: bounded(input.intervalMs, 1000, 100, 60_000),
  leaseMs: bounded(input.leaseMs, 300_000, 10_000, 1_200_000),
  retryMs: bounded(input.retryMs, 15_000, 1000, 3_600_000),
  maxRetryMs: bounded(input.maxRetryMs, 3_600_000, 60_000, 86_400_000),
  batchSize: bounded(input.batchSize, 10, 1, 100),
  concurrency: bounded(input.concurrency, 2, 1, 4),
  statementTimeoutMs: bounded(input.statementTimeoutMs, 120_000, 1000, 900_000),
});

function buildRuntime(deps, options) {
  const database = deps.database || db;
  return Object.freeze({
    queue: (deps.queueFactory || createRobinhoodBundleRedistributionLiveQueueRepository)({ database }),
    source: (deps.sourceFactory || createRobinhoodBundleRedistributionLiveSource)({
      database, statementTimeoutMs: options.statementTimeoutMs,
    }),
  });
}

function buildSnapshot(task, evidence, decisions) {
  const groups = decisions.flatMap((decision) => decision.group ? [decision.group] : []);
  return Object.freeze({
    state: Object.freeze({
      tokenAddress: task.tokenAddress, ruleVersion: RULE_VERSION,
      evidenceVersion: EVIDENCE_VERSION, status: 'ready',
      statusReason: groups.length ? 'groups_found' : 'no_groups', sourceKind: 'live',
      sourceVersion: task.requestedVersion,
      throughBlockNumber: evidence.frontier.blockNumber,
      throughBlockHash: evidence.frontier.blockHash, policyJson: POLICY,
    }),
    groups: Object.freeze(groups),
  });
}

async function processTask(runtime, task) {
  const evidence = await runtime.source.loadToken(task.tokenAddress, {
    observationFromBlock: task.observationFromBlock,
  });
  if (!evidence.ready) {
    const error = new Error(`redistribution source unavailable: ${evidence.reason}`);
    error.code = 'redistribution_source_not_ready'; error.reason = evidence.reason;
    throw error;
  }
  const decisions = evidence.sources.map((source) => evaluateBundleRedistribution({
    ...source, creatorAddress: evidence.creatorAddress,
    barrierAddresses: evidence.barrierAddresses,
  }));
  const snapshot = buildSnapshot(task, evidence, decisions);
  const stored = await runtime.queue.replaceSnapshotAndComplete({ ...task, snapshot });
  return Object.freeze({
    status: stored.completed ? 'materialized' : 'stale', tokenAddress: task.tokenAddress,
    sources: evidence.sources.length, groups: snapshot.groups.length,
    members: snapshot.groups.reduce((total, group) => total + group.memberCount, 0),
  });
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length); let cursor = 0;
  const next = async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1; results[index] = await operation(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

function createRobinhoodBundleRedistributionLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout; const cancel = deps.cancelSchedule || clearTimeout;
  const owner = deps.owner || `bundle-redistribution-${process.pid}-${randomUUID()}`;
  let options = normalizeOptions(); let runtime; let timer; let listener; let active; let running = false;
  const status = { enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalClaimed: 0, totalMaterialized: 0, totalDeferred: 0, lastResult: null,
    lastError: null, lastCompletedAt: null };
  const getRuntime = () => (runtime ||= deps.runtime || buildRuntime(deps, options));
  const retryDelay = (attempt) => Math.min(options.maxRetryMs,
    options.retryMs * (2 ** Math.min(Math.max(attempt - 1, 0), 8)));
  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    try {
      const tasks = await getRuntime().queue.claimBatch({
        owner, leaseMs: options.leaseMs, limit: options.batchSize,
      });
      if (!tasks.length) return { status: 'caught_up', claimed: 0 };
      status.totalClaimed += tasks.length;
      const results = await mapConcurrent(tasks, options.concurrency, async (task) => {
        try { return await processTask(getRuntime(), { ...task, owner }); }
        catch (error) {
          await getRuntime().queue.retry({ ...task, owner,
            retryMs: retryDelay(task.attemptCount), error }).catch(() => {});
          return { status: 'deferred', error };
        }
      });
      const materialized = results.filter(({ status: value }) => value === 'materialized').length;
      const deferred = results.filter(({ status: value }) => value === 'deferred');
      status.totalMaterialized += materialized; status.totalDeferred += deferred.length;
      status.lastError = deferred.length ? {
        code: deferred[0].error.code || 'redistribution_live_error',
        message: deferred[0].error.message,
      } : null;
      return { status: deferred.length ? 'partial' : 'drained',
        claimed: tasks.length, materialized, deferred: deferred.length };
    } catch (error) {
      status.lastError = { code: error.code || 'redistribution_live_error', message: error.message };
      return null;
    } finally { status.inFlight = false; status.lastCompletedAt = new Date().toISOString(); }
  }
  async function runOnce() {
    if (active) return active;
    active = execute().then((result) => { status.lastResult = result; return result; })
      .finally(() => { active = null; });
    return active;
  }
  function queue(delay = options.intervalMs) {
    if (!running) return;
    timer = schedule(async () => { timer = null; await runOnce(); queue(); }, delay); timer?.unref?.();
  }
  function wake() { if (running && !active) { if (timer) cancel(timer); timer = null; queue(0); } }
  function start(input = {}) {
    if (running) return false; options = normalizeOptions(input); status.enabled = options.enabled;
    if (!options.enabled) return false; getRuntime(); running = true; status.running = true;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({ channel: NOTIFY_CHANNEL,
      label: 'RobinhoodBundleRedistributionLiveWorker', pool: deps.pool || db.pool,
      onNotification: wake });
    Promise.resolve(listener.start()).catch((error) => {
      status.lastError = { code: 'redistribution_listener_error', message: error.message };
    });
    queue(0); return true;
  }
  async function stop() {
    running = false; status.running = false; if (timer) cancel(timer); timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {}); if (active) await active.catch(() => {});
  }
  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodBundleRedistributionLiveWorker();
module.exports = { createRobinhoodBundleRedistributionLiveWorker, processTask,
  getStatus: worker.getStatus, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, buildSnapshot, mapConcurrent, normalizeOptions } };
