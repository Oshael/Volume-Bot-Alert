const os = require('node:os');
const {
  createRobinhoodFreshWalletRpcSource, resolveRobinhoodFreshWalletRpcProvider,
} = require('./robinhood-fresh-wallet-rpc-source');
const { createRobinhoodRpcClient } = require('./robinhood-ingestion-worker');
const { processTask, __private: { mapConcurrent } } = require('./robinhood-fresh-wallet-live-worker');

const MAX_HOURS = 5;
const SAFETY_FACTOR = 1.25;
const isRunnablePlan = (plan) => plan?.ready && plan.pairCount;
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

async function runPreflight(deps = {}, options = {}) {
  const repository = deps.repository;
  if (!repository?.loadPlan || !repository?.samplePairs) throw new Error('FRESH seed repository required');
  const sampleCount = bounded(options.sampleCount ?? 3, 3, 1, 64);
  const concurrency = bounded(options.concurrency ?? 2, 2, 1, 16);
  const maxHours = Number(options.maxHours ?? MAX_HOURS);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > MAX_HOURS) {
    throw new Error(`maxHours must be greater than 0 and at most ${MAX_HOURS}`);
  }
  const plan = await repository.loadPlan();
  if (!isRunnablePlan(plan)) return Object.freeze({ ...plan, approved: false });
  const samples = await repository.samplePairs(sampleCount);
  const source = deps.source || createArchiveSource(options, deps);
  const now = deps.now || Date.now; const startedAt = now();
  let sampledUnavailable = samples.length ? 0 : 1;
  await mapConcurrent(samples, concurrency, async (item) => {
    try { await source.readEvidence(item); } catch (_) { sampledUnavailable += 1; }
  });
  const elapsedMs = Math.max(1, now() - startedAt);
  const projectedMs = Math.ceil((elapsedMs / Math.max(1, samples.length))
    * plan.pairCount * SAFETY_FACTOR);
  return Object.freeze({ ...plan, approved: sampledUnavailable === 0
    && projectedMs <= maxHours * 3_600_000, sampleCount: samples.length,
  sampledUnavailable, concurrency, safetyFactor: SAFETY_FACTOR, projectedMs,
  projectedHours: Number((projectedMs / 3_600_000).toFixed(2)), maxHours });
}

function assertApproved(preflight) {
  if (!preflight?.approved) throw Object.assign(
    new Error('FRESH seed refused: archive evidence or projected capacity is insufficient'),
    { code: 'fresh_seed_preflight_refused' }
  );
}

async function drainBatch(context, tasks) {
  await mapConcurrent(tasks, context.concurrency, async (task) => {
    try { await processTask({ sourceKind: 'seed', source: context.source,
      shadow: context.shadow }, {
      ...task, owner: context.owner,
    }); } catch (error) {
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
  const maxMinutes = bounded(options.maxMinutes ?? 285, 285, 1, 300);
  const owner = options.owner || `${os.hostname()}:${process.pid}:fresh-seed`;
  const run = await repository.createOrResume(options.preflight);
  if (run.status === 'completed') return repository.syncProgress(run.runId);
  const source = deps.source || createArchiveSource(options, deps);
  const deadline = (deps.now || Date.now)() + maxMinutes * 60_000;
  const context = { source, shadow, queue, concurrency, owner,
    retryMs: options.retryMs ?? 15_000 };
  while ((deps.now || Date.now)() < deadline) {
    const tasks = await queue.claimBatch({ owner, sourceKind: 'seed', seedRunId: run.runId,
      leaseMs: options.leaseMs ?? 300_000, limit: batchSize });
    if (!tasks.length) break;
    await drainBatch(context, tasks);
    options.onProgress?.(await repository.syncProgress(run.runId));
  }
  const progress = await repository.syncProgress(run.runId);
  return progress.status === 'completed' ? progress : repository.syncProgress(run.runId, true);
}

module.exports = { createArchiveSource, executeSeed, runPreflight };
