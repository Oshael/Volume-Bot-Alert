const os = require('node:os');

const MAX_PROJECTED_HOURS = 5;
const SAFETY_FACTOR = 1.25;
const DEFAULT_PROJECTION_VERSION = 'rh_transfer_v1';
const DEFAULT_REPLAY_VERSION = 'rh_directional_transfer_replay_v1';

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function block(value, label) {
  const parsed = String(value ?? '').trim();
  if (!/^\d+$/.test(parsed)) throw new Error(`${label} must be a block number`);
  return BigInt(parsed);
}

function checkpointHash(value) {
  const parsed = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(parsed)) throw new Error('sourceThroughHash is invalid');
  return parsed;
}

function observedCount(value, label) {
  if (value == null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function plan(input = {}) {
  const sourceFrom = block(input.sourceFromBlock, 'sourceFromBlock');
  const sourceThrough = block(input.sourceThroughBlock, 'sourceThroughBlock');
  if (sourceFrom > sourceThrough) throw new Error('sourceThroughBlock precedes sourceFromBlock');
  const rangeBlocks = integer(input.rangeBlocks ?? 1000, 'rangeBlocks', 1, 5000);
  const sampleCount = integer(input.sampleCount ?? 3, 'sampleCount', 1, 12);
  const rangeCountBig = ((sourceThrough - sourceFrom) / BigInt(rangeBlocks)) + 1n;
  if (rangeCountBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('rangeCount is too large');
  const rangeCount = Number(rangeCountBig);
  const wanted = Math.min(sampleCount, rangeCount);
  const indexes = new Set(Array.from({ length: wanted }, (_, index) => (
    wanted === 1 ? 0 : Math.round((index * (rangeCount - 1)) / (wanted - 1))
  )));
  const samples = [...indexes].map((index) => {
    const rangeStart = sourceFrom + (BigInt(index) * BigInt(rangeBlocks));
    const candidateEnd = rangeStart + BigInt(rangeBlocks - 1);
    return Object.freeze({
      rangeStartBlock: rangeStart.toString(),
      rangeEndBlock: (candidateEnd < sourceThrough ? candidateEnd : sourceThrough).toString(),
    });
  });
  return Object.freeze({
    projectionVersion: input.projectionVersion || DEFAULT_PROJECTION_VERSION,
    replayVersion: input.replayVersion || DEFAULT_REPLAY_VERSION,
    sourceFromBlock: sourceFrom.toString(), sourceThroughBlock: sourceThrough.toString(),
    sourceThroughHash: checkpointHash(input.sourceThroughHash),
    rangeBlocks, rangeCount, samples: Object.freeze(samples),
  });
}

async function runPreflight(deps = {}, options = {}) {
  if (typeof deps.writer?.probeRange !== 'function') throw new Error('replay probe is required');
  const workload = plan(options);
  const concurrency = integer(options.concurrency ?? 2, 'concurrency', 1, 16);
  const maxHours = Number(options.maxHours ?? MAX_PROJECTED_HOURS);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > MAX_PROJECTED_HOURS) {
    throw new Error(`maxHours must be greater than 0 and at most ${MAX_PROJECTED_HOURS}`);
  }
  const now = deps.now || Date.now;
  const observations = [];
  for (const range of workload.samples) {
    const startedAt = now();
    const result = await deps.writer.probeRange(range);
    observations.push(Object.freeze({ ...result, elapsedMs: Math.max(1, now() - startedAt) }));
  }
  const averageMs = observations.reduce((sum, item) => sum + item.elapsedMs, 0)
    / observations.length;
  const projectedMs = Math.ceil(
    (averageMs * workload.rangeCount * SAFETY_FACTOR) / concurrency
  );
  const nonCanonicalRanges = observations.filter((item) => item.checkpointCanonical !== true).length;
  const total = (key) => observations.reduce(
    (sum, item) => sum + observedCount(item[key], key), 0
  );
  return Object.freeze({
    ...workload, concurrency, maxHours, safetyFactor: SAFETY_FACTOR,
    sampledRanges: observations.length, averageSampleMs: Math.ceil(averageMs),
    projectedMs, projectedHours: Number((projectedMs / 3_600_000).toFixed(2)),
    nonCanonicalRanges, sampleRpcRequests: total('rpcRequests'),
    sampleTransfersScanned: total('transfersScanned'),
    sampleEdgesConsidered: total('edgesConsidered'),
    approved: nonCanonicalRanges === 0 && projectedMs <= maxHours * 3_600_000,
  });
}

function assertApproved(preflight) {
  if (preflight?.approved) return;
  const error = new Error(preflight?.nonCanonicalRanges
    ? 'directional replay refused: sampled checkpoint is not canonical'
    : 'directional replay refused: projected runtime exceeds five-hour cap');
  error.code = 'directional_replay_preflight_refused';
  throw error;
}

function sameFrozenSource(run, preflight) {
  return run.projectionVersion === preflight.projectionVersion
    && run.replayVersion === preflight.replayVersion
    && run.sourceFromBlock === preflight.sourceFromBlock
    && run.sourceThroughBlock === preflight.sourceThroughBlock
    && run.sourceThroughHash === preflight.sourceThroughHash
    && run.rangeBlocks === preflight.rangeBlocks;
}

async function resolveRun(repository, options) {
  let run = options.runId ? await repository.getRun(options.runId) : null;
  if (options.runId && !run) throw new Error('directional replay run was not found');
  if (run && !sameFrozenSource(run, options.preflight)) {
    throw new Error('preflight does not match the frozen directional replay run');
  }
  if (!run) run = await repository.createRun(options.preflight);
  await repository.ensureTokenScope(run.id);
  if (run.status === 'planned') {
    await repository.startRun(run.id);
    return { ...run, status: 'running' };
  }
  if (options.retryFailed) {
    if (!options.runId || run.status !== 'failed') {
      throw new Error('failed-run retry requires an explicit failed run');
    }
    return { ...run, status: 'running', ...await repository.resumeFailed(run.id) };
  }
  return run;
}

async function drainWorker(context, index) {
  const { repository, writer, run, concurrency, options, sleep, leaseMs, maxAttempts } = context;
  const owner = `${context.ownerPrefix}:${index}`;
  while (true) {
    const range = await repository.claimRange({ runId: run.id, owner, leaseMs });
    if (!range) {
      let progress = await repository.getProgress({ runId: run.id, concurrency });
      if (progress?.status === 'running' && progress.failed > 0
          && progress.pending === 0 && progress.leased === 0) {
        await repository.settleTokenRepairDiscovery(run.id);
        progress = await repository.getProgress({ runId: run.id, concurrency });
      }
      options.onProgress?.(progress);
      if (!progress || progress.status !== 'running') return;
      await sleep(options.pollMs ?? 1000);
      continue;
    }
    try {
      const result = await writer.materializeRange(range);
      await repository.completeRange({
        runId: run.id, rangeId: range.id, owner,
        completedThroughBlock: result.completedThroughBlock,
        completedThroughHash: result.completedThroughHash,
        blocksScanned: result.blocksScanned, transfersScanned: result.transfersScanned,
        edgesConsidered: result.edgesConsidered, edgesWritten: result.edgesWritten,
      });
    } catch (error) {
      let failure = error;
      let repairCandidateStaged = false;
      if (error.code === 'directional_replay_edge_missing') {
        try {
          await repository.stageTokenRepairCandidates({
            runId: run.id, tokenAddresses: error.tokenAddresses,
          });
          repairCandidateStaged = true;
        } catch (candidateError) {
          failure = candidateError;
        }
      }
      if (repairCandidateStaged) {
        await repository.deferRangeForTokenRepair({
          runId: run.id, rangeId: range.id, owner, error,
        });
      } else {
        await repository.retryRange({
          runId: run.id, rangeId: range.id, owner, error: failure, maxAttempts,
          backoffMs: Math.min(60_000, 1000 * (2 ** Math.max(0, range.attemptCount - 1))),
        });
      }
    }
    options.onProgress?.(await repository.getProgress({ runId: run.id, concurrency }));
  }
}

async function executeReplay(deps = {}, options = {}) {
  assertApproved(options.preflight);
  const repository = deps.repository;
  const writer = deps.writer;
  if (!repository || typeof writer?.materializeRange !== 'function') {
    throw new Error('directional replay repository and writer are required');
  }
  const concurrency = integer(options.preflight.concurrency, 'concurrency', 1, 16);
  const run = await resolveRun(repository, options);
  if (!['running', 'completed'].includes(run.status)) {
    throw new Error(`directional replay cannot resume from ${run.status}`);
  }
  options.onRun?.(Object.freeze({
    runId: run.id, status: run.status, requeued: run.requeued || 0,
  }));
  if (run.status === 'completed') {
    return Object.freeze({
      runId: run.id, ...await repository.getProgress({ runId: run.id, concurrency }),
    });
  }
  await repository.reclaimExpired(run.id);
  const context = {
    repository, writer, run, concurrency, options,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    leaseMs: integer(options.leaseMs ?? 180_000, 'leaseMs', 120_001, 1_200_000),
    maxAttempts: integer(options.maxAttempts ?? 5, 'maxAttempts', 1, 20),
    ownerPrefix: options.owner || `${os.hostname()}:${process.pid}`,
  };
  await Promise.all(Array.from(
    { length: concurrency }, (_, index) => drainWorker(context, index + 1)
  ));
  return Object.freeze({
    runId: run.id, ...await repository.getProgress({ runId: run.id, concurrency }),
  });
}

module.exports = { executeReplay, plan, runPreflight };
