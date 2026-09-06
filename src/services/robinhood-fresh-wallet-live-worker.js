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
const {
  isSafeSignedOriginUnavailableReason,
} = require('./robinhood-wallet-signed-origin-domain');
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
  lanes: bounded(input.lanes, 1, 1, 16),
  rpcSubBatchSize: bounded(input.rpcSubBatchSize, 10, 1, 100),
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
    rpcSubBatchSize: options.rpcSubBatchSize,
  });
  return Object.freeze({ sourceKind: 'live',
    queue: (deps.queueFactory || createRobinhoodFreshWalletLiveQueueRepository)({ database }),
    shadow: (deps.shadowFactory || createRobinhoodFreshWalletShadowRepository)({ database }),
    source: (deps.sourceFactory || createRobinhoodFreshWalletSignedOriginSource)({
      database, canonicalSource,
    }),
  });
}

function prepareTask(runtime, task, evidence) {
  if (!['seed', 'live'].includes(task.sourceKind)
      || runtime.sourceKind !== task.sourceKind
      || runtime.source?.sourceKind !== task.sourceKind) {
    throw Object.assign(new Error('FRESH task source_kind does not match its adapter'), {
      code: 'fresh_source_kind_mismatch',
    });
  }
  const decision = evaluateRobinhoodFreshWallet(evidence);
  return { ...task, status: 'ready', evidence, decision };
}

function unavailableTask(task, error) {
  return { ...task, status: 'unavailable', statusReason: error.reason,
    evidence: { source: 'robinhood-signed-origin-index', sourceKind: 'live',
      observedAt: new Date().toISOString(), error: { code: error.code, reason: error.reason } },
  };
}

async function materializeUnavailable(runtime, task, error) {
  const result = await runtime.shadow.replaceAndComplete(
    unavailableTask(task, error), { allowReset: true }
  );
  return Object.freeze({ status: result.completed ? 'materialized' : 'stale',
    tokenAddress: task.tokenAddress, walletAddress: task.walletAddress, outcome: null });
}

async function processTask(runtime, task, suppliedEvidence = null) {
  let evidence;
  try { evidence = suppliedEvidence == null
    ? await runtime.source.readEvidence(task) : await suppliedEvidence; }
  catch (error) {
    if (error.code !== 'fresh_signed_origin_unavailable'
        || !isSafeSignedOriginUnavailableReason(error.reason)) throw error;
    return materializeUnavailable(runtime, task, error);
  }
  const prepared = prepareTask(runtime, task, evidence);
  const result = await runtime.shadow.replaceAndComplete({
    ...prepared,
  }, { allowForkReplacement: true });
  return Object.freeze({
    status: result.completed ? 'materialized' : 'stale',
    tokenAddress: task.tokenAddress, walletAddress: task.walletAddress,
    outcome: result.completed ? prepared.decision.outcome : null,
  });
}

async function processTaskBatch(runtime, tasks, evidence) {
  if (typeof runtime.shadow?.replaceAndCompleteBatch !== 'function'
      || !Array.isArray(evidence) || evidence.length !== tasks.length) {
    throw new Error('FRESH batch materializer is unavailable');
  }
  const prepared = tasks.map((task, index) => prepareTask(runtime, task, evidence[index]));
  const stored = await runtime.shadow.replaceAndCompleteBatch(prepared,
    { allowForkReplacement: true });
  return Object.freeze(stored.map((result, index) => Object.freeze({
    status: result.completed ? 'materialized' : 'stale',
    tokenAddress: tasks[index].tokenAddress, walletAddress: tasks[index].walletAddress,
    outcome: result.completed ? prepared[index].decision.outcome : null,
  })));
}

async function processOutcomeBatch(runtime, tasks, outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length !== tasks.length) {
    throw new Error('FRESH live evidence batch is incomplete');
  }
  const results = new Array(tasks.length); const prepared = [];
  tasks.forEach((task, index) => {
    const outcome = outcomes[index] || {};
    try {
      if (outcome.error) {
        if (outcome.error.code !== 'fresh_signed_origin_unavailable'
            || !isSafeSignedOriginUnavailableReason(outcome.error.reason)) throw outcome.error;
        prepared.push({ index, input: unavailableTask(task, outcome.error), outcome: null });
      } else {
        const input = prepareTask(runtime, task, outcome.evidence);
        prepared.push({ index, input, outcome: input.decision.outcome });
      }
    } catch (error) { results[index] = { status: 'deferred', error }; }
  });
  if (prepared.length) {
    const stored = await runtime.shadow.replaceAndCompleteBatch(
      prepared.map(({ input }) => input), { allowForkReplacement: true, allowReset: true }
    );
    if (!Array.isArray(stored) || stored.length !== prepared.length) {
      throw new Error('FRESH live materialization batch is incomplete');
    }
    prepared.forEach(({ index, input, outcome }, offset) => {
      results[index] = { status: stored[offset].completed ? 'materialized' : 'stale',
        tokenAddress: input.tokenAddress, walletAddress: input.walletAddress, outcome };
    });
  }
  return results;
}

async function processClaimed(runtime, tasks, concurrency, clock = Date.now) {
  let outcomes = null;
  let evidenceMs = 0; let persistMs = 0;
  if (typeof runtime.source?.readEvidenceBatchResults === 'function'
      && typeof runtime.shadow?.replaceAndCompleteBatch === 'function') {
    const evidenceStartedAt = clock();
    try { outcomes = await runtime.source.readEvidenceBatchResults(tasks); } catch (_) {}
    evidenceMs = Math.max(0, clock() - evidenceStartedAt);
    if (outcomes) {
      const persistStartedAt = clock();
      try {
        return { results: await processOutcomeBatch(runtime, tasks, outcomes),
          batchMode: 'rpc_and_persist', evidenceMs,
          persistMs: Math.max(0, clock() - persistStartedAt), fallbackMs: 0 };
      } catch (_) {
        persistMs = Math.max(0, clock() - persistStartedAt);
        /* Fall through with the already fetched evidence. */
      }
    }
  }
  const fallbackStartedAt = clock();
  const results = await mapConcurrent(tasks, concurrency, async (task, index) => {
    try {
      const outcome = outcomes?.[index];
      if (outcome?.error) {
        if (outcome.error.code === 'fresh_signed_origin_unavailable'
            && isSafeSignedOriginUnavailableReason(outcome.error.reason)) {
          return materializeUnavailable(runtime, task, outcome.error);
        }
        throw outcome.error;
      }
      return await processTask(runtime, task, outcome?.evidence);
    } catch (error) { return { status: 'deferred', error }; }
  });
  return { results, batchMode: outcomes ? 'rpc_only' : 'individual', evidenceMs, persistMs,
    fallbackMs: Math.max(0, clock() - fallbackStartedAt) };
}

async function mapConcurrent(items, concurrency, operation) {
  const results = new Array(items.length); let cursor = 0;
  const next = async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1; results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function processLane(runtime, options, owner, retryDelay, clock) {
  const startedAt = clock(); const claimStartedAt = clock();
  const tasks = await runtime.queue.claimBatch({
    owner, leaseMs: options.leaseMs, limit: options.batchSize,
  });
  const claimMs = Math.max(0, clock() - claimStartedAt);
  if (!tasks.length) return { status: 'caught_up', claimed: 0, materialized: 0,
    deferred: 0, batchMode: 'idle', claimMs, evidenceMs: 0, persistMs: 0,
    fallbackMs: 0, elapsedMs: Math.max(1, clock() - startedAt) };
  const owned = tasks.map((task) => ({ ...task, owner }));
  const processed = await processClaimed(runtime, owned, options.concurrency, clock)
    .catch(() => null);
  const results = processed?.results || await mapConcurrent(owned,
    options.concurrency, async (task) => {
    try { return await processTask(runtime, task); }
    catch (error) {
      await runtime.queue.retry({ ...task,
        retryMs: retryDelay(task.attemptCount), error }).catch(() => {});
      return { status: 'deferred', error };
    }
  });
  await Promise.all(results.map(async (result, index) => {
    if (result.status !== 'deferred' || !processed) return;
    const task = owned[index];
    await runtime.queue.retry({ ...task,
      retryMs: retryDelay(task.attemptCount), error: result.error }).catch(() => {});
  }));
  const failures = results.filter(({ status }) => status === 'deferred');
  const materialized = results.filter(({ status }) => status === 'materialized');
  return { status: failures.length ? 'partial' : 'drained', claimed: tasks.length,
    materialized: materialized.length, deferred: failures.length,
    notFresh: materialized.filter(({ outcome }) => outcome === 'not_fresh').length,
    batchMode: processed?.batchMode || 'individual', claimMs,
    evidenceMs: processed?.evidenceMs || 0, persistMs: processed?.persistMs || 0,
    fallbackMs: processed?.fallbackMs || 0, elapsedMs: Math.max(1, clock() - startedAt),
    firstError: failures[0]?.error || null };
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
    const startedAt = now();
    status.circuitOpenUntil = null; status.inFlight = true; status.totalRuns += 1;
    try {
      const settled = await Promise.allSettled(Array.from({ length: options.lanes }, () => (
        processLane(getRuntime(), options, owner, retryDelay, now)
      )));
      const laneResults = settled.filter(({ status: value }) => value === 'fulfilled')
        .map(({ value }) => value);
      const laneErrors = settled.filter(({ status: value }) => value === 'rejected')
        .map(({ reason }) => reason);
      if (!laneResults.length) throw laneErrors[0];
      const sum = (field) => laneResults.reduce((total, lane) => total + (lane[field] || 0), 0);
      const peak = (field) => Math.max(0, ...laneResults.map((lane) => lane[field] || 0));
      const claimed = sum('claimed'); const materialized = sum('materialized');
      const deferred = sum('deferred');
      if (!claimed && !laneErrors.length) {
        status.consecutiveFailures = 0; status.circuitOpenUntil = null; status.lastError = null;
        return { status: 'caught_up', claimed: 0, lanes: options.lanes,
          claimMs: peak('claimMs') };
      }
      status.totalClaimed += claimed; status.totalDeferred += deferred;
      status.totalMaterialized += materialized; status.totalNotFresh += sum('notFresh');
      if (materialized) {
        status.consecutiveFailures = 0; status.circuitOpenUntil = null; status.lastError = null;
      } else if (deferred || laneErrors.length) {
        recordFailure(laneResults.find(({ firstError }) => firstError)?.firstError || laneErrors[0]);
      }
      const elapsedMs = Math.max(1, now() - startedAt);
      const modes = [...new Set(laneResults.filter(({ claimed: count }) => count)
        .map(({ batchMode }) => batchMode))];
      return { status: deferred || laneErrors.length ? 'partial' : 'drained',
        claimed, materialized, deferred, lanes: options.lanes,
        activeLanes: laneResults.filter(({ claimed: count }) => count).length,
        laneErrors: laneErrors.length, batchMode: modes.length === 1 ? modes[0] : 'mixed',
        claimMs: peak('claimMs'), evidenceMs: peak('evidenceMs'),
        persistMs: peak('persistMs'), fallbackMs: peak('fallbackMs'), elapsedMs,
        itemsPerSecond: Number(((materialized * 1000) / elapsedMs).toFixed(2)) };
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
    timer = schedule(async () => { timer = null; const result = await runOnce();
      queue(result?.claimed >= options.batchSize * options.lanes ? 0 : options.intervalMs);
    }, delay); timer?.unref?.();
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
  processTaskBatch, getStatus: worker.getStatus, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, mapConcurrent, normalizeOptions, prepareTask,
    processClaimed, processOutcomeBatch } };
