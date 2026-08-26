const MAX_HOURS = 5;
const SAFETY_FACTOR = 1.25;

function integer(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function samples(targets, batchSize, sampleCount) {
  const batchCount = Math.ceil(targets.length / batchSize);
  const count = Math.min(batchCount, sampleCount);
  if (!count) return Object.freeze({ batchCount, batches: Object.freeze([]) });
  const indexes = new Set(Array.from({ length: count }, (_, index) => (
    count === 1 ? 0 : Math.round((index * (batchCount - 1)) / (count - 1))
  )));
  return Object.freeze({
    batchCount,
    batches: Object.freeze([...indexes].map((index) => (
      Object.freeze(targets.slice(index * batchSize, (index + 1) * batchSize))
    ))),
  });
}

async function runPreflight(repository, options = {}) {
  if (!repository?.loadPlan || !repository?.probeTargets) {
    throw new Error('launch-anchor repository is required');
  }
  const batchSize = integer(options.batchSize ?? 500, 'batchSize', 10, 5_000);
  const sampleCount = integer(options.sampleCount ?? 3, 'sampleCount', 1, 12);
  const concurrency = integer(options.concurrency ?? 4, 'concurrency', 1, 16);
  const maxHours = Number(options.maxHours ?? MAX_HOURS);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > MAX_HOURS) {
    throw new Error(`maxHours must be greater than 0 and at most ${MAX_HOURS}`);
  }
  const plan = await repository.loadPlan();
  if (!plan.ready) return Object.freeze({ report: Object.freeze({ ...plan, approved: false }), plan });
  const workload = samples(plan.targets, batchSize, sampleCount);
  const now = options.now || Date.now;
  const observations = [];
  for (const batch of workload.batches) {
    const startedAt = now();
    const result = await repository.probeTargets(batch);
    observations.push({ ...result, elapsedMs: Math.max(1, now() - startedAt) });
  }
  const averageMs = observations.length
    ? observations.reduce((sum, item) => sum + item.elapsedMs, 0) / observations.length : 0;
  const projectedMs = Math.ceil(
    (averageMs * workload.batchCount * SAFETY_FACTOR) / concurrency
  );
  const report = Object.freeze({
    ready: true, approved: projectedMs <= maxHours * 3_600_000,
    sourceThroughBlock: plan.sourceThroughBlock,
    candidateTargets: plan.targets.length,
    unavailableWithoutPool: plan.unavailableWithoutPool,
    batchSize, batchCount: workload.batchCount, concurrency,
    sampleCount: observations.length, averageSampleMs: Math.ceil(averageMs),
    sampledUnavailable: observations.reduce((sum, item) => sum + item.unavailable, 0),
    safetyFactor: SAFETY_FACTOR, maxHours, projectedMs,
    projectedHours: Number((projectedMs / 3_600_000).toFixed(2)),
  });
  return Object.freeze({ report, plan });
}

module.exports = { runPreflight, __private: { samples } };
