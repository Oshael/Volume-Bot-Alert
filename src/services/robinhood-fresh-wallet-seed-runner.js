const os = require('node:os');
const {
  createRobinhoodFreshWalletRpcSource, resolveRobinhoodFreshWalletRpcProvider,
} = require('./robinhood-fresh-wallet-rpc-source');
const { createRobinhoodRpcClient } = require('./robinhood-ingestion-worker');
const {
  processTask, processTaskBatch, __private: { mapConcurrent },
} = require('./robinhood-fresh-wallet-live-worker');

const DEFAULT_MAX_HOURS = 5;
const MAX_HOURS = 24;
const MAX_SESSION_MINUTES = 1440;
const SAFETY_FACTOR = 1.25;
const PROGRESS_PAIR_INTERVAL = 10_000;
const isRunnablePlan = (plan) => plan?.ready
  && Number(plan.tokenCount) > 0 && Number(plan.pairCount) > 0;
const bounded = (value, fallback, min, max) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`value must be between ${min} and ${max}`);
  }
  return parsed;
};

function createArchiveSource(options = {}, deps = {}) {
  const provider = (deps.providerResolver || resolveRobinhoodFreshWalletRpcProvider)(
    deps.env || process.env, 'archive'
  );
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)({
    publicRpcUrl: provider.url, rpcTimeoutMs: options.timeoutMs || 60_000,
    rpcMaxRetries: options.rpcMaxRetries ?? 2, rpcMinIntervalMs: options.rpcMinIntervalMs ?? 0,
    useAlchemy: false, useDrpc: false,
  });
  return (deps.sourceFactory || createRobinhoodFreshWalletRpcSource)({
    rpcClient, source: provider.name, sourceKind: 'seed',
  });
}

async function sampleEvidence(source, samples, concurrency) {
  if (!samples.length) return 1;
  if (typeof source.readEvidenceBatch === 'function') {
    try {
      const evidence = await source.readEvidenceBatch(samples);
      return Array.isArray(evidence) && evidence.length === samples.length ? 0 : samples.length;
    } catch (_) { return samples.length; }
  }
  let unavailable = 0;
  await mapConcurrent(samples, concurrency, async (item) => {
    try { await source.readEvidence(item); } catch (_) { unavailable += 1; }
  });
  return unavailable;
}

async function runPreflight(deps = {}, options = {}) {
  const repository = deps.repository;
  if (!repository?.loadPlan || !repository?.samplePairs) throw new Error('FRESH seed repository required');
  const batchSize = bounded(options.batchSize ?? 10, 10, 1, 100);
  const requestedSampleCount = bounded(options.sampleCount ?? 3, 3, 1, 100);
  const sampleCount = Math.max(requestedSampleCount, batchSize);
  const concurrency = bounded(options.concurrency ?? 2, 2, 1, 16);
  const maxHours = Number(options.maxHours ?? DEFAULT_MAX_HOURS);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > MAX_HOURS) {
    throw new Error(`maxHours must be greater than 0 and at most ${MAX_HOURS}`);
  }
  const plan = await repository.loadPlan();
  if (!isRunnablePlan(plan)) return Object.freeze({ ...plan, approved: false });
  const samples = await repository.samplePairs(sampleCount);
  const source = deps.source || createArchiveSource(options, deps);
  const now = deps.now || Date.now; const startedAt = now();
  const sampledUnavailable = await sampleEvidence(source, samples, concurrency);
  const elapsedMs = Math.max(1, now() - startedAt);
  const projectedMs = Math.ceil((elapsedMs / Math.max(1, samples.length))
    * plan.pairCount * SAFETY_FACTOR);
  return Object.freeze({ ...plan, approved: sampledUnavailable === 0,
    durationAdvisoryExceeded: projectedMs > maxHours * 3_600_000, sampleCount: samples.length,
  sampledUnavailable, batchSize, concurrency, safetyFactor: SAFETY_FACTOR, projectedMs,
  projectedHours: Number((projectedMs / 3_600_000).toFixed(2)), maxHours });
}

function assertApproved(preflight) {
  if (!preflight?.approved) throw Object.assign(
    new Error('FRESH seed refused: Archive evidence is unavailable'),
    { code: 'fresh_seed_preflight_refused' }
  );
}

async function drainBatch(context, tasks) {
  let evidence;
  if (typeof context.source.readEvidenceBatch === 'function') {
    try { evidence = await context.source.readEvidenceBatch(tasks); }
    catch (_) { evidence = null; }
  }
  if (evidence && typeof context.shadow.replaceAndCompleteBatch === 'function') {
    try { await processTaskBatch({ sourceKind: 'seed', source: context.source,
      shadow: context.shadow }, tasks.map((task) => ({ ...task, owner: context.owner })), evidence);
    return; } catch (_) { /* Fall back per item to isolate malformed or conflicting work. */ }
  }
  await mapConcurrent(tasks, context.concurrency, async (task, index) => {
    try { await processTask({ sourceKind: 'seed', source: context.source,
      shadow: context.shadow }, { ...task, owner: context.owner }, evidence?.[index]); }
    catch (error) {
      await context.queue.retry({ ...task, owner: context.owner,
        retryMs: context.retryMs, error }).catch(() => {});
    }
  });
}

function assertSeedRuntime(repository, queue, shadow) {
  if (!repository) throw new Error('FRESH seed repository required');
  if (!queue?.claimBatch) throw new Error('FRESH seed queue required');
  if (!shadow) throw new Error('FRESH seed shadow writer required');
}

async function executeSeed(deps = {}, options = {}) {
  assertApproved(options.preflight);
  const repository = deps.repository;
  const queue = deps.queue;
  const shadow = deps.shadow;
  assertSeedRuntime(repository, queue, shadow);
  const concurrency = bounded(options.preflight.concurrency, 2, 1, 16);
  const batchSize = bounded(options.batchSize ?? 10, 10, 1, 100);
  const maxMinutes = bounded(options.maxMinutes ?? 285, 285, 1, MAX_SESSION_MINUTES);
  const owner = options.owner || `${os.hostname()}:${process.pid}:fresh-seed`;
  const run = await repository.createOrResume(options.preflight);
  if (run.status === 'completed') return repository.syncProgress(run.runId);
  const source = deps.source || createArchiveSource(options, deps);
  const deadline = (deps.now || Date.now)() + maxMinutes * 60_000;
  const context = { source, shadow, queue, concurrency, owner,
    retryMs: options.retryMs ?? 15_000 };
  let pairsSinceProgress = 0;
  while ((deps.now || Date.now)() < deadline) {
    const tasks = await queue.claimBatch({ owner, sourceKind: 'seed', seedRunId: run.runId,
      leaseMs: options.leaseMs ?? 300_000, limit: batchSize });
    if (!tasks.length) break;
    await drainBatch(context, tasks);
    pairsSinceProgress += tasks.length;
    if (pairsSinceProgress >= PROGRESS_PAIR_INTERVAL) {
      options.onProgress?.(await repository.syncProgress(run.runId));
      pairsSinceProgress = 0;
    }
  }
  return repository.syncProgress(run.runId, true);
}

module.exports = { createArchiveSource, executeSeed, runPreflight };
