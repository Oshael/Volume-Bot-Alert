const os = require('node:os');

const MAX_PROJECTED_HOURS = 5;
const SAFETY_FACTOR = 1.25;

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function plan(input = {}) {
  const sourceFrom = new Date(input.sourceFrom);
  const sourceThrough = new Date(input.sourceThrough);
  if (!Number.isFinite(sourceFrom.getTime()) || !Number.isFinite(sourceThrough.getTime())) {
    throw new Error('source bounds must be instants');
  }
  if (sourceFrom >= sourceThrough) throw new Error('sourceThrough must be after sourceFrom');
  const rangeSeconds = integer(input.rangeSeconds ?? 3600, 'rangeSeconds', 60, 86_400);
  const sampleCount = integer(input.sampleCount ?? 3, 'sampleCount', 1, 12);
  const rangeMs = rangeSeconds * 1000;
  const rangeCount = Math.ceil((sourceThrough - sourceFrom) / rangeMs);
  const wanted = Math.min(sampleCount, rangeCount);
  const indexes = new Set(Array.from({ length: wanted }, (_, index) => (
    wanted === 1 ? 0 : Math.round((index * (rangeCount - 1)) / (wanted - 1))
  )));
  const samples = [...indexes].map((index) => {
    const start = sourceFrom.getTime() + (index * rangeMs);
    return Object.freeze({
      rangeStart: new Date(start).toISOString(),
      rangeEnd: new Date(Math.min(start + rangeMs, sourceThrough.getTime())).toISOString(),
    });
  });
  return Object.freeze({
    sourceFrom: sourceFrom.toISOString(), sourceThrough: sourceThrough.toISOString(),
    rangeSeconds, rangeCount, samples: Object.freeze(samples),
  });
}

async function runPreflight(deps = {}, options = {}) {
  if (!deps.firstBuyRepository?.probeRange) throw new Error('first-buy probe is required');
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
    const result = await deps.firstBuyRepository.probeRange(range);
    observations.push(Object.freeze({ ...result, elapsedMs: Math.max(1, now() - startedAt) }));
  }
  const averageMs = observations.reduce((sum, item) => sum + item.elapsedMs, 0)
    / observations.length;
  const projectedMs = Math.ceil(
    (averageMs * workload.rangeCount * SAFETY_FACTOR) / concurrency
  );
  const missingPositions = observations.reduce((sum, item) => sum + item.missingPositions, 0);
  return Object.freeze({
    ...workload, concurrency, maxHours, safetyFactor: SAFETY_FACTOR,
    sampledRanges: observations.length, averageSampleMs: Math.ceil(averageMs),
    projectedMs, projectedHours: Number((projectedMs / 3_600_000).toFixed(2)),
    missingPositions,
    approved: missingPositions === 0 && projectedMs <= maxHours * 3_600_000,
  });
}

function assertApproved(preflight) {
  if (!preflight?.approved) {
    const error = new Error(preflight?.missingPositions
      ? 'first-buy backfill refused: canonical positions are missing'
      : 'first-buy backfill refused: projected runtime exceeds capacity cap');
    error.code = 'first_buy_backfill_preflight_refused';
    throw error;
  }
}

async function resolveRun(repository, options) {
  let run = options.runId ? await repository.getRun(options.runId) : null;
  if (options.runId && !run) throw new Error('first-buy backfill run was not found');
  if (run && (run.sourceFrom !== options.preflight.sourceFrom
    || run.sourceThrough !== options.preflight.sourceThrough
    || run.rangeSeconds !== options.preflight.rangeSeconds)) {
    throw new Error('preflight does not match the existing backfill run');
  }
  if (!run) run = await repository.createRun(options.preflight);
  if (run.status === 'planned') {
    await repository.startRun(run.id);
    return { ...run, status: 'running' };
  }
  if (options.retryFailed) {
    if (!options.runId || run.status !== 'failed') {
      throw new Error('failed-run retry requires an explicit failed run');
    }
    const recovery = await repository.resumeFailed(run.id);
    return { ...run, status: 'running', ...recovery };
  }
  return run;
}

async function drainWorker(context, index) {
  const { repository, writer, run, concurrency, options, sleep, leaseMs, maxAttempts } = context;
  const owner = `${context.ownerPrefix}:${index}`;
  while (true) {
    const range = await repository.claimRange({ runId: run.id, owner, leaseMs });
    if (!range) {
      const progress = await repository.getProgress({ runId: run.id, concurrency });
      options.onProgress?.(progress);
      if (!progress || progress.status !== 'running') return;
      await sleep(options.pollMs ?? 1000);
      continue;
    }
    try {
      const result = await writer.materializeRange(range);
      await repository.completeRange({
        runId: run.id, rangeId: range.id, owner,
        rowsScanned: result.rowsScanned, factsConsidered: result.factsConsidered,
        factsWritten: result.factsWritten,
      });
    } catch (error) {
      await repository.retryRange({
        runId: run.id, rangeId: range.id, owner, error, maxAttempts,
        backoffMs: Math.min(60_000, 1000 * (2 ** Math.max(0, range.attemptCount - 1))),
      });
    }
    options.onProgress?.(await repository.getProgress({ runId: run.id, concurrency }));
  }
}

async function executeBackfill(deps = {}, options = {}) {
  assertApproved(options.preflight);
  const repository = deps.backfillRepository;
  const writer = deps.firstBuyRepository;
  if (!repository || !writer?.materializeRange) throw new Error('backfill repositories are required');
  const concurrency = integer(options.preflight.concurrency, 'concurrency', 1, 16);
  const run = await resolveRun(repository, options);
  if (!['running', 'completed'].includes(run.status)) {
    throw new Error(`first-buy backfill run cannot resume from ${run.status}`);
  }
  options.onRun?.(Object.freeze({
    runId: run.id, status: run.status, requeued: run.requeued || 0,
    subdivided: run.subdivided || 0, addedRanges: run.addedRanges || 0,
  }));
  if (run.status === 'completed') {
    const progress = await repository.getProgress({ runId: run.id, concurrency });
    return Object.freeze({ runId: run.id, ...progress });
  }
  await repository.reclaimExpired(run.id);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const leaseMs = integer(options.leaseMs ?? 180_000, 'leaseMs', 120_001, 1_200_000);
  const maxAttempts = integer(options.maxAttempts ?? 5, 'maxAttempts', 1, 20);
  const ownerPrefix = options.owner || `${os.hostname()}:${process.pid}`;
  const context = {
    repository, writer, run, concurrency, options, sleep, leaseMs, maxAttempts, ownerPrefix,
  };
  await Promise.all(Array.from(
    { length: concurrency }, (_, index) => drainWorker(context, index + 1)
  ));
  const progress = await repository.getProgress({ runId: run.id, concurrency });
  return Object.freeze({ runId: run.id, ...progress });
}

module.exports = { executeBackfill, plan, runPreflight };
