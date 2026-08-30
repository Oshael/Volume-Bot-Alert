const { randomUUID } = require('crypto');
const db = require('../models/db');
const {
  createRobinhoodFreshWalletLiveQueueRepository,
} = require('../models/robinhood-fresh-wallet-live-queue');
const {
  createRobinhoodFreshWalletShadowRepository,
} = require('../models/robinhood-fresh-wallet-shadow');
const { createRobinhoodRpcClient } = require('./robinhood-ingestion-worker');
const {
  createRobinhoodFreshWalletRpcSource, resolveRobinhoodFreshWalletRpcProvider,
} = require('./robinhood-fresh-wallet-rpc-source');
const {
  createRobinhoodFreshWalletSignedOriginSource,
} = require('./robinhood-fresh-wallet-signed-origin-source');
const { evaluateRobinhoodFreshWallet } = require('./robinhood-fresh-wallet-rule');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = 'robinhood_fresh_wallet_queue';
const bounded = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
};
const normalizeOptions = (input = {}) => Object.freeze({
  enabled: input.enabled === true,
  intervalMs: bounded(input.intervalMs, 1000, 100, 60_000),
  leaseMs: bounded(input.leaseMs, 300_000, 10_000, 1_200_000),
  retryMs: bounded(input.retryMs, 15_000, 1000, 3_600_000),
  maxRetryMs: bounded(input.maxRetryMs, 3_600_000, 60_000, 86_400_000),
  batchSize: bounded(input.batchSize, 10, 1, 100),
  concurrency: bounded(input.concurrency, 2, 1, 4),
  timeoutMs: bounded(input.timeoutMs, 30_000, 1000, 300_000),
  circuitFailureThreshold: bounded(input.circuitFailureThreshold, 5, 1, 100),
  circuitResetMs: bounded(input.circuitResetMs, 60_000, 1000, 3_600_000),
  signedOriginApproved: input.signedOriginApproved === true,
  rpcOptions: input.rpcOptions || {},
});

function buildRuntime(deps, options) {
  const database = deps.database || db;
  const provider = (deps.providerResolver || resolveRobinhoodFreshWalletRpcProvider)(
    deps.env || process.env, 'live'
  );
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)({
    ...options.rpcOptions, publicRpcUrl: provider.url, rpcTimeoutMs: options.timeoutMs,
  });
  const canonicalSource = (deps.canonicalSourceFactory || createRobinhoodFreshWalletRpcSource)({
    rpcClient, source: provider.name, sourceKind: 'live',
  });
  return Object.freeze({ sourceKind: 'live',
    queue: (deps.queueFactory || createRobinhoodFreshWalletLiveQueueRepository)({ database }),
    shadow: (deps.shadowFactory || createRobinhoodFreshWalletShadowRepository)({ database }),
    source: (deps.sourceFactory || createRobinhoodFreshWalletSignedOriginSource)({
      database, canonicalSource,
    }),
  });
}

async function processTask(runtime, task) {
  if (!['seed', 'live'].includes(task.sourceKind)
      || runtime.sourceKind !== task.sourceKind
      || runtime.source?.sourceKind !== task.sourceKind) {
    throw Object.assign(new Error('FRESH task source_kind does not match its adapter'), {
      code: 'fresh_source_kind_mismatch',
    });
  }
  const evidence = await runtime.source.readEvidence(task);
  const decision = evaluateRobinhoodFreshWallet(evidence);
  const result = await runtime.shadow.replaceAndComplete({
    ...task, status: 'ready', evidence, decision,
  }, { allowForkReplacement: true });
  return Object.freeze({
    status: result.completed ? 'materialized' : 'stale',
    tokenAddress: task.tokenAddress, walletAddress: task.walletAddress,
    outcome: result.completed ? decision.outcome : null,
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

function createRobinhoodFreshWalletLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout; const cancel = deps.cancelSchedule || clearTimeout;
  const now = deps.now || Date.now; const owner = deps.owner || `fresh-${process.pid}-${randomUUID()}`;
  let options = normalizeOptions(); let runtime; let timer; let listener; let active; let running = false;
  const status = { enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalClaimed: 0, totalMaterialized: 0, totalNotFresh: 0, totalDeferred: 0,
    consecutiveFailures: 0, circuitOpenUntil: null, lastResult: null,
    lastError: null, lastCompletedAt: null };
  const getRuntime = () => (runtime ||= deps.runtime || buildRuntime(deps, options));
  const retryDelay = (attempt) => Math.min(options.maxRetryMs,
    options.retryMs * (2 ** Math.min(Math.max(attempt - 1, 0), 8)));
  const circuitOpen = () => status.circuitOpenUntil != null
    && now() < Date.parse(status.circuitOpenUntil);
  function recordFailure(error) {
    status.consecutiveFailures += 1;
    status.lastError = { code: error.code || 'fresh_wallet_live_error', message: error.message };
    if (status.consecutiveFailures >= options.circuitFailureThreshold) {
      status.circuitOpenUntil = new Date(now() + options.circuitResetMs).toISOString();
    }
  }
  async function execute() {
    if (circuitOpen()) return { status: 'circuit_open', until: status.circuitOpenUntil };
    status.circuitOpenUntil = null; status.inFlight = true; status.totalRuns += 1;
    try {
      const tasks = await getRuntime().queue.claimBatch({
        owner, leaseMs: options.leaseMs, limit: options.batchSize,
      });
      if (!tasks.length) {
        status.consecutiveFailures = 0; status.circuitOpenUntil = null; status.lastError = null;
        return { status: 'caught_up', claimed: 0 };
      }
      status.totalClaimed += tasks.length;
      const results = await mapConcurrent(tasks, options.concurrency, async (task) => {
        try { return await processTask(getRuntime(), { ...task, owner }); }
        catch (error) {
          await getRuntime().queue.retry({ ...task, owner,
            retryMs: retryDelay(task.attemptCount), error }).catch(() => {});
          return { status: 'deferred', error };
        }
      });
      const failures = results.filter(({ status: value }) => value === 'deferred');
      const materialized = results.filter(({ status: value }) => value === 'materialized');
      status.totalDeferred += failures.length; status.totalMaterialized += materialized.length;
      status.totalNotFresh += materialized.filter(({ outcome }) => outcome === 'not_fresh').length;
      if (materialized.length) {
        status.consecutiveFailures = 0; status.circuitOpenUntil = null; status.lastError = null;
      } else if (failures.length) recordFailure(failures[0].error);
      return { status: failures.length ? 'partial' : 'drained',
        claimed: tasks.length, materialized: materialized.length, deferred: failures.length };
    } catch (error) { recordFailure(error); return null; }
    finally { status.inFlight = false; status.lastCompletedAt = new Date(now()).toISOString(); }
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
    if (!options.enabled) return false;
    if (!options.signedOriginApproved) {
      status.lastError = { code: 'fresh_signed_origin_not_approved',
        message: 'FRESH signed-origin equivalence is not approved' };
      return false;
    }
    getRuntime(); running = true; status.running = true;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: NOTIFY_CHANNEL, label: 'RobinhoodFreshWalletLiveWorker',
      pool: deps.pool || db.pool, onNotification: wake,
    });
    Promise.resolve(listener.start()).catch((error) => { status.lastError = { message: error.message }; });
    queue(0); return true;
  }
  async function stop() { running = false; status.running = false; if (timer) cancel(timer); timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {}); if (active) await active.catch(() => {}); }
  return Object.freeze({ getStatus: () => ({ ...status, circuitOpen: circuitOpen() }),
    runOnce, start, stop });
}

const worker = createRobinhoodFreshWalletLiveWorker();
module.exports = { NOTIFY_CHANNEL, createRobinhoodFreshWalletLiveWorker, processTask,
  getStatus: worker.getStatus, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, mapConcurrent, normalizeOptions } };
