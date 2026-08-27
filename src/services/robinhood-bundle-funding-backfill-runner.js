const os = require('node:os');
const { materializeBundleFundingRange } = require('./robinhood-bundle-funding-materializer');
const EVIDENCE_VERSION = 'rh_native_funding_v2';

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function resolveRun(repository, options) {
  let run = options.runId ? await repository.getRun(options.runId) : null;
  if (options.runId && !run) throw new Error('bundle funding run was not found');
  if (!run) {
    if (!options.preflight?.approved) throw new Error('bundle funding preflight is not approved');
    run = await repository.createRun({ plan: options.plan, preflight: options.preflight });
  }
  return run;
}

async function resumeFailed(repository, options, run) {
  if (!options.retryFailed) return run;
  if (!options.runId || run.status !== 'failed') {
    throw new Error('failed-run retry requires an explicit failed run');
  }
  return { ...run, status: 'running', ...await repository.resumeFailed(run.id) };
}

function waitForHeartbeat(stopped, heartbeatMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), heartbeatMs);
    stopped.then(() => { clearTimeout(timer); resolve(true); });
  });
}

async function materializeWithHeartbeat(context, range, owner) {
  let stop;
  let heartbeatError;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const heartbeat = (async () => {
    while (!await waitForHeartbeat(stopped, context.heartbeatMs)) {
      try {
        await context.repository.renewRangeLease({
          runId: context.run.id, rangeIndex: range.rangeIndex,
          owner, leaseMs: context.leaseMs,
        });
      } catch (error) { heartbeatError = error; return; }
    }
  })();
  let result;
  let operationError;
  try {
    result = await context.materialize({
      range, lookbackBlocks: context.run.lookbackBlocks,
      batchBlocks: context.run.batchBlocks,
    }, { reader: context.reader, now: context.now });
  } catch (error) { operationError = error; }
  stop();
  await heartbeat;
  if (heartbeatError) throw heartbeatError;
  if (operationError) throw operationError;
  return result;
}

async function drainWorker(context, index) {
  const owner = `${context.ownerPrefix}:${index}`;
  while (context.now() < context.deadline) {
    const range = await context.repository.claimRange({
      runId: context.run.id, owner, leaseMs: context.leaseMs,
    });
    if (!range) {
      const progress = await context.repository.getProgress(context.run.id);
      context.options.onProgress?.(progress);
      if (!progress || progress.status !== 'running') return;
      if (index === 1 && progress.leased > 0) {
        await context.repository.reclaimExpired(context.run.id);
      }
      await context.sleep(context.options.pollMs ?? 500);
      continue;
    }
    try {
      const result = await materializeWithHeartbeat(context, range, owner);
      await context.repository.completeRange({
        runId: context.run.id, rangeIndex: range.rangeIndex, owner,
        completedThroughHash: result.completedThroughHash,
        nativeTransfersScanned: result.nativeTransfersScanned,
        rawEvents: result.rawEvents, edges: result.edges,
        causalEvidence: result.causalEvidence,
      });
    } catch (error) {
      await context.repository.retryRange({
        runId: context.run.id, rangeIndex: range.rangeIndex, owner, error,
        maxAttempts: context.maxAttempts,
        backoffMs: Math.min(60_000, 1000 * (2 ** Math.max(0, range.attemptCount - 1))),
      });
    }
    context.options.onProgress?.(await context.repository.getProgress(context.run.id));
  }
}

async function assertFrozenArchive(reader, run) {
  const chainId = await reader.assertChain();
  const checkpoint = await reader.checkpoint(run.sourceThroughBlock);
  if (chainId !== '4663' || checkpoint !== run.sourceThroughHash) {
    throw new Error('bundle funding frozen archive checkpoint is not canonical');
  }
}

function assertDependencies(repository, reader) {
  if (!repository) throw new Error('bundle funding repository is required');
  if (!reader) throw new Error('bundle funding reader is required');
}

async function executeBundleFundingBackfill(deps = {}, options = {}) {
  const { repository, reader } = deps;
  assertDependencies(repository, reader);
  let run = await resolveRun(repository, options);
  if (run.evidenceVersion !== EVIDENCE_VERSION) {
    throw new Error(`bundle funding run evidence version must be ${EVIDENCE_VERSION}`);
  }
  options.onRun?.({ runId: run.id, status: run.status, requeued: run.requeued || 0 });
  if (run.status === 'completed') return { runId: run.id, ...await repository.getProgress(run.id) };
  await assertFrozenArchive(reader, run);
  run = await resumeFailed(repository, options, run);
  if (run.status !== 'running') throw new Error(`bundle funding run cannot resume from ${run.status}`);
  await repository.reclaimExpired(run.id);
  const now = deps.now || Date.now;
  const maxMinutes = integer(options.maxMinutes ?? 285, 'maxMinutes', 1, 300);
  const leaseMs = integer(options.leaseMs ?? 180_000, 'leaseMs', 120_001, 1_200_000);
  const context = {
    repository, reader, run, options, now, leaseMs,
    deadline: now() + maxMinutes * 60_000,
    heartbeatMs: integer(deps.heartbeatMs ?? Math.floor(leaseMs / 3), 'heartbeatMs', 1, 400_000),
    maxAttempts: integer(options.maxAttempts ?? 5, 'maxAttempts', 1, 20),
    ownerPrefix: options.owner || `${os.hostname()}:${process.pid}`,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    materialize: deps.materialize || materializeBundleFundingRange,
  };
  await Promise.all(Array.from(
    { length: run.concurrency }, (_, index) => drainWorker(context, index + 1)
  ));
  const progress = await repository.getProgress(run.id);
  return Object.freeze({ runId: run.id, stoppedReason: progress?.status === 'running'
    ? 'max_runtime' : null, ...progress });
}

module.exports = { executeBundleFundingBackfill };
