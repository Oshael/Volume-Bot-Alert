require('dotenv').config();

const os = require('node:os');
const db = require('../models/db');
const {
  createRobinhoodLaunchAnchorBackfillRepository,
} = require('../models/robinhood-launch-anchor-backfill');
const {
  runPreflight,
} = require('../services/robinhood-launch-anchor-backfill-preflight');

const VALUE_ARGUMENTS = new Set([
  'run-id', 'batch-size', 'concurrency', 'samples', 'max-hours', 'statement-timeout-ms',
]);
const MIN_BATCH_SIZE = 10;

function bounded(value, fallback, min, max, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--apply' && !values.apply) values.apply = true;
    else {
      const match = argument.match(/^--([a-z-]+)=(.+)$/);
      if (!match || !VALUE_ARGUMENTS.has(match[1]) || values[match[1]] != null) {
        throw new Error(`unknown or repeated argument: ${argument}`);
      }
      values[match[1]] = match[2];
    }
  }
  const runId = values['run-id'] == null ? null
    : String(bounded(values['run-id'], null, 1, Number.MAX_SAFE_INTEGER, '--run-id'));
  return Object.freeze({
    apply: values.apply === true, runId,
    batchSize: bounded(values['batch-size'], 500, MIN_BATCH_SIZE, 5_000, '--batch-size'),
    concurrency: bounded(values.concurrency, 4, 1, 16, '--concurrency'),
    sampleCount: bounded(values.samples, 3, 1, 12, '--samples'),
    maxHours: bounded(values['max-hours'], 5, 1, 5, '--max-hours'),
    statementTimeoutMs: bounded(
      values['statement-timeout-ms'], 120_000, 1_000, 900_000, '--statement-timeout-ms'
    ),
  });
}

function progressReporter(logger, now = Date.now) {
  let lastPct = -1;
  let lastAt = 0;
  return (progress) => {
    const timestamp = now();
    if (progress.status === 'running'
      && progress.progressPct < lastPct + 1 && timestamp - lastAt < 10_000) return;
    (logger.error || logger.log).call(logger,
      `[LaunchAnchorBackfill] ${progress.status} ${progress.completed}/${progress.total}`
      + ` unavailable=${progress.unavailable} failed=${progress.failed}`
      + ` (${progress.progressPct}%) eta=${progress.etaSeconds ?? 'calculating'}s`);
    lastPct = progress.progressPct;
    lastAt = timestamp;
  };
}

function isStatementTimeout(error) {
  return error?.code === '57014' || /statement timeout/i.test(String(error?.message || ''));
}

async function drainWorker(context, index) {
  let batchSize = context.options.batchSize;
  const owner = `${context.ownerPrefix}:${index}`;
  while (context.now() < context.deadline) {
    let result;
    try {
      result = await context.repository.materializeBatch({
        runId: context.runId, owner, limit: batchSize, leaseMs: context.leaseMs,
      });
    } catch (error) {
      if (!isStatementTimeout(error) || batchSize <= MIN_BATCH_SIZE) throw error;
      batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
      (context.logger.error || context.logger.log).call(context.logger,
        `[LaunchAnchorBackfill] statement timeout; worker=${index} batch-size=${batchSize}`);
      continue;
    }
    if (result.claimed) context.completedBatches += 1;
    const shouldReport = !result.claimed || result.status !== 'running'
      || context.completedBatches % (context.options.concurrency * 2) === 0;
    const progress = shouldReport
      ? await context.repository.getProgress(context.runId) : null;
    if (progress) context.reportProgress(progress);
    if (result.status !== 'running' || (progress && progress.status !== 'running')) return;
    if (!result.claimed) await context.sleep(250);
  }
  const error = new Error('launch-anchor backfill reached the runtime cap');
  error.code = 'launch_anchor_backfill_runtime_cap';
  throw error;
}

async function execute(repository, preflight, options, deps = {}) {
  if (!preflight.report.approved) {
    const error = new Error('launch-anchor backfill preflight refused write');
    error.code = 'launch_anchor_backfill_preflight_refused';
    throw error;
  }
  let runId = options.runId;
  if (!runId && preflight.plan.targets.length) {
    runId = (await repository.createRun(preflight)).id;
  }
  if (!runId) return Object.freeze({ status: 'completed', runId: null, total: 0 });
  const logger = deps.logger || console;
  (logger.error || logger.log).call(logger, `[LaunchAnchorBackfill] run-id=${runId}`);
  const progress = await repository.getProgress(runId);
  if (progress?.status === 'completed') return Object.freeze({ runId, ...progress });
  const now = deps.now || Date.now;
  const context = {
    repository, runId, options, logger,
    ownerPrefix: deps.owner || `${os.hostname()}:${process.pid}`,
    leaseMs: Math.max(180_000, options.statementTimeoutMs + 60_000),
    deadline: now() + options.maxHours * 3_600_000,
    now,
    completedBatches: 0,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    reportProgress: progressReporter(logger, now),
  };
  await Promise.all(Array.from(
    { length: options.concurrency }, (_, index) => drainWorker(context, index + 1)
  ));
  return Object.freeze({ runId, ...await repository.getProgress(runId) });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  const repository = deps.repository || createRobinhoodLaunchAnchorBackfillRepository({
    database, statementTimeoutMs: options.statementTimeoutMs,
  });
  const source = options.runId ? {
    loadPlan: () => repository.loadRunPlan(options.runId),
    probeTargets: (targets) => repository.probeTargets(targets),
  } : repository;
  const preflight = await runPreflight(source, { ...options, now: deps.now });
  const report = { mode: 'preflight', runId: options.runId, ...preflight.report };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  if (!options.apply) return report;
  const result = await execute(repository, preflight, options, deps);
  (deps.logger || console).log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('[LaunchAnchorBackfill] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { execute, main, parseArgs, progressReporter };
