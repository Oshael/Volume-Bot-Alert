const { plan } = require('./robinhood-first-buy-backfill-runner');

const SAFETY_FACTOR = 1.25;

function ranges(workload) {
  const start = new Date(workload.sourceFrom).getTime();
  const end = new Date(workload.sourceThrough).getTime();
  const width = workload.rangeSeconds * 1000;
  return Array.from({ length: workload.rangeCount }, (_, index) => Object.freeze({
    rangeStart: new Date(start + (index * width)).toISOString(),
    rangeEnd: new Date(Math.min(start + ((index + 1) * width), end)).toISOString(),
  }));
}

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function inspectRange(deps, range, options, commit) {
  let transactions = 0;
  let rpcBlocks = 0;
  let rpcBatches = 0;
  let persisted = 0;
  let truncated = false;
  do {
    const missing = await deps.source.listMissing({ ...range, limit: options.batchSize });
    if (!missing.length) break;
    truncated = missing.length === options.batchSize;
    const resolved = await deps.resolver.resolveSwaps(missing, { commit });
    transactions += resolved.telemetry.required;
    rpcBlocks += resolved.telemetry.rpcBlocks;
    rpcBatches += resolved.telemetry.rpcBatches;
    persisted += resolved.telemetry.persisted;
    if (!commit) break;
  } while (truncated);
  return Object.freeze({ ...range, transactions, rpcBlocks, rpcBatches, persisted, truncated });
}

async function runPreflight(deps, input = {}) {
  const workload = plan(input);
  const concurrency = bounded(input.concurrency, 2, 1, 8, 'concurrency');
  const batchSize = bounded(input.batchSize, 10_000, 1, 10_000, 'batchSize');
  const maxHours = bounded(input.maxHours, 5, 1, 5, 'maxHours');
  const observations = [];
  for (const range of workload.samples) {
    const now = deps.now || Date.now;
    const startedAt = now();
    const result = await inspectRange(deps, range, { batchSize }, false);
    observations.push({ ...result, elapsedMs: Math.max(1, now() - startedAt) });
  }
  const averageSampleMs = Math.ceil(
    observations.reduce((sum, item) => sum + item.elapsedMs, 0) / observations.length
  );
  const projectedMs = Math.ceil(
    (averageSampleMs * workload.rangeCount * SAFETY_FACTOR) / concurrency
  );
  const truncatedSamples = observations.filter((item) => item.truncated).length;
  return Object.freeze({
    ...workload, concurrency, batchSize, maxHours, safetyFactor: SAFETY_FACTOR,
    sampledRanges: observations.length, averageSampleMs, projectedMs,
    projectedHours: Number((projectedMs / 3_600_000).toFixed(2)), truncatedSamples,
    sampleTransactions: observations.reduce((sum, item) => sum + item.transactions, 0),
    approved: truncatedSamples === 0 && projectedMs <= maxHours * 3_600_000,
  });
}

async function executeRepair(deps, input = {}) {
  if (!input.preflight?.approved) throw new Error('position repair preflight was not approved');
  const workload = plan(input.preflight);
  const plannedRanges = ranges(workload);
  const maxMinutes = bounded(input.maxMinutes, 240, 1, 300, 'maxMinutes');
  const now = deps.now || Date.now;
  const deadline = now() + (maxMinutes * 60_000);
  const states = plannedRanges.map(() => 'pending');
  let nextIndex = 0;
  let totals = { ranges: 0, transactions: 0, rpcBlocks: 0, persisted: 0 };
  async function worker() {
    while (now() < deadline) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= plannedRanges.length) return;
      states[index] = 'running';
      const result = await inspectRange(deps, plannedRanges[index], input.preflight, true);
      states[index] = 'completed';
      totals = {
        ranges: totals.ranges + 1,
        transactions: totals.transactions + result.transactions,
        rpcBlocks: totals.rpcBlocks + result.rpcBlocks,
        persisted: totals.persisted + result.persisted,
      };
      input.onProgress?.(Object.freeze({ ...totals, totalRanges: workload.rangeCount }));
    }
  }
  await Promise.all(Array.from({ length: input.preflight.concurrency }, () => worker()));
  const firstPending = states.findIndex((state) => state !== 'completed');
  return Object.freeze({
    status: firstPending === -1 ? 'completed' : 'paused', ...totals,
    totalRanges: workload.rangeCount,
    resumeFrom: firstPending === -1 ? null : plannedRanges[firstPending].rangeStart,
  });
}

module.exports = { executeRepair, runPreflight, __private: { inspectRange, ranges } };
