require('dotenv').config();

const db = require('../models/db');
const {
  DEFAULT_PROJECTION_VERSION,
  DEFAULT_REPLAY_VERSION,
  createRobinhoodDirectionalTransferReplayRepository,
} = require('../models/robinhood-directional-transfer-replay');
const {
  createRobinhoodDirectionalTransferEvidenceRepository,
} = require('../models/robinhood-directional-transfer-evidence');
const {
  executeReplay,
  runPreflight,
} = require('../services/robinhood-directional-transfer-replay-runner');
const {
  createRobinhoodDirectionalTransferReplayWriter,
} = require('../services/robinhood-directional-transfer-replay-writer');
const {
  buildRuntime: buildArchiveTransferRuntime,
  runtimeOptions,
} = require('./backfill-robinhood-wallet-transfers');

const VALUE_ARGUMENTS = new Set([
  'run-id', 'range-blocks', 'concurrency', 'samples', 'max-hours',
  'lease-ms', 'max-attempts',
]);
const REPLAY_DATA_DB_CONCURRENCY = 8;

function createGate(limit) {
  let active = 0;
  const waiting = [];
  function release() {
    const next = waiting.shift();
    if (next) next(release);
    else active -= 1;
  }
  async function acquire() {
    if (active >= limit) return new Promise((resolve) => waiting.push(resolve));
    active += 1;
    return release;
  }
  return { acquire };
}

function createReplayDataDatabase(database, concurrency = REPLAY_DATA_DB_CONCURRENCY) {
  const gate = createGate(concurrency);
  async function query(...args) {
    const release = await gate.acquire();
    try {
      return await database.query(...args);
    } finally {
      release();
    }
  }
  async function getClient() {
    const release = await gate.acquire();
    try {
      const client = await database.getClient();
      let released = false;
      return {
        query: client.query.bind(client),
        release() {
          if (released) return;
          released = true;
          client.release();
          release();
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  return Object.freeze({ query, getClient });
}

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function argumentValues(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--apply' || argument === '--retry-failed') {
      const key = argument.slice(2).replace('-failed', 'Failed');
      if (values[key]) throw new Error(`${argument} cannot be repeated`);
      values[key] = true;
      continue;
    }
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match || !VALUE_ARGUMENTS.has(match[1])) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (values[match[1]] !== undefined) throw new Error(`--${match[1]} cannot be repeated`);
    values[match[1]] = match[2];
  }
  return values;
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = argumentValues(argv);
  if (values['run-id'] && values['range-blocks']) {
    throw new Error('--run-id cannot be combined with --range-blocks');
  }
  if (values.retryFailed && (!values['run-id'] || !values.apply)) {
    throw new Error('--retry-failed requires --run-id and --apply');
  }
  return Object.freeze({
    apply: values.apply === true,
    retryFailed: values.retryFailed === true,
    runId: values['run-id'],
    rangeBlocks: bounded(values['range-blocks'], 1000, 1, 5000, '--range-blocks'),
    concurrency: bounded(values.concurrency, 2, 1, 16, '--concurrency'),
    sampleCount: bounded(values.samples, 3, 1, 12, '--samples'),
    maxHours: bounded(values['max-hours'], 5, 1, 5, '--max-hours'),
    leaseMs: bounded(values['lease-ms'], 180_000, 120_001, 1_200_000, '--lease-ms'),
    maxAttempts: bounded(values['max-attempts'], 5, 1, 20, '--max-attempts'),
  });
}

function unavailable(reason) {
  const error = new Error(`directional replay source unavailable: ${reason}`);
  error.code = 'directional_replay_source_unavailable';
  return error;
}

function frozenSourceFromPlan(plan, rangeBlocks) {
  if (!plan?.ready || plan.status !== 'complete') {
    throw unavailable(plan?.reason || `transfer_seed_${plan?.status || 'missing'}`);
  }
  const checkpointBlock = plan.live?.checkpointBlock;
  const checkpointHash = plan.live?.checkpointHash;
  if (plan.fromBlock == null || checkpointBlock == null || checkpointHash == null
      || BigInt(plan.fromBlock) > BigInt(checkpointBlock)) {
    throw unavailable('transfer_live_checkpoint_invalid');
  }
  return Object.freeze({
    projectionVersion: DEFAULT_PROJECTION_VERSION,
    replayVersion: DEFAULT_REPLAY_VERSION,
    sourceFromBlock: plan.fromBlock,
    sourceThroughBlock: checkpointBlock,
    sourceThroughHash: checkpointHash,
    rangeBlocks,
  });
}

async function resolveSource(runtime, options) {
  let source;
  if (options.runId) {
    source = await runtime.repository.getRun(options.runId);
    if (!source) throw new Error('directional replay run was not found');
    const readiness = await runtime.repository.getTokenScopeReadiness(options.runId);
    if (!readiness.ready) {
      const error = unavailable('token_coverage_incomplete');
      error.message += ` (${readiness.tokenCount} eligible, ${readiness.unavailable} unavailable)`;
      error.details = readiness;
      throw error;
    }
  } else {
    const plan = await runtime.tickDeps.source.loadBackfillPlan(DEFAULT_PROJECTION_VERSION);
    source = frozenSourceFromPlan(plan, options.rangeBlocks);
  }
  const canonical = await runtime.tickDeps.evidence.matchesCheckpoint({
    number: source.sourceThroughBlock,
    hash: source.sourceThroughHash,
  });
  if (!canonical) throw unavailable('transfer_live_checkpoint_not_canonical');
  return source;
}

async function assertSchema(database) {
  const result = await database.query(
    `SELECT
       to_regclass('robinhood_directional_transfer_replay_runs') AS runs,
       to_regclass('robinhood_directional_transfer_replay_ranges') AS ranges,
       to_regclass('robinhood_directional_transfer_replay_tokens') AS tokens,
       to_regclass('robinhood_directional_transfer_deployment_gaps') AS deployment_gaps,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'robinhood_wallet_transfer_token_coverage'
            AND column_name = 'published_at'
       ) AS publication,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'robinhood_wallet_transfer_edges'
            AND column_name = 'first_wallet_transfer_block'
       ) AS evidence`
  );
  const schema = result.rows[0] || {};
  if (!schema.evidence || !schema.runs || !schema.ranges
      || !schema.tokens || !schema.deployment_gaps || !schema.publication) {
    throw new Error('schema not ready: apply Stages 153, 154, 158, 159 and 160 on the VPS');
  }
}

async function buildRuntime(options = {}, deps = {}) {
  const database = deps.database || db;
  const dataDatabase = createReplayDataDatabase(database);
  await assertSchema(database);
  const transfer = await (deps.archiveRuntimeFactory || buildArchiveTransferRuntime)(
    options, { ...deps, database: dataDatabase }
  );
  const repository = (deps.replayRepositoryFactory
    || createRobinhoodDirectionalTransferReplayRepository)({ database });
  const evidenceRepository = (deps.evidenceRepositoryFactory
    || createRobinhoodDirectionalTransferEvidenceRepository)({ database: dataDatabase });
  const writer = (deps.writerFactory || createRobinhoodDirectionalTransferReplayWriter)({
    rangeDeps: transfer.tickDeps,
    repository: evidenceRepository,
    tokenScope: repository,
  });
  return Object.freeze({
    ...transfer, repository, writer,
  });
}

function progressReporter(logger) {
  let previous;
  return (progress) => {
    if (!progress) return;
    const message = `[DirectionalReplay] ${progress.status} ${progress.completed}/${progress.total}`
      + ` (${progress.progressPct}%) eta=${progress.etaSeconds ?? 'calculating'}s`;
    if (message !== previous) (logger.error || logger.log).call(logger, message);
    previous = message;
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const logger = deps.logger || console;
  const runtime = deps.runtime || await (deps.runtimeFactory || buildRuntime)(
    deps.runtimeOptions || runtimeOptions(), deps
  );
  const source = await resolveSource(runtime, options);
  (logger.error || logger.log).call(logger, '[DirectionalReplay] mandatory read-only preflight...');
  const preflight = await (deps.preflight || runPreflight)({
    writer: runtime.writer, now: deps.now,
  }, {
    ...source,
    concurrency: options.concurrency,
    sampleCount: options.sampleCount,
    maxHours: options.maxHours,
  });
  logger.log(JSON.stringify({ mode: 'preflight', providerChainIds: runtime.providerChainIds,
    ...preflight }, null, 2));
  if (!options.apply) return preflight;
  const result = await (deps.replay || executeReplay)({
    repository: runtime.repository, writer: runtime.writer, sleep: deps.sleep,
  }, {
    preflight, runId: options.runId, retryFailed: options.retryFailed,
    leaseMs: options.leaseMs, maxAttempts: options.maxAttempts,
    onProgress: progressReporter(logger),
    onControlRetry: ({ operation, attempt, delayMs, error }) => (
      logger.error || logger.log
    ).call(logger, `[DirectionalReplay] DB acquisition retry operation=${operation}`
      + ` attempt=${attempt} delay=${delayMs}ms error=${error.message}`),
    onRun: ({ runId, status, requeued }) => (logger.error || logger.log).call(
      logger, `[DirectionalReplay] run-id=${runId} status=${status} requeued=${requeued}`
    ),
  });
  logger.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('[DirectionalReplay] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end());

module.exports = {
  assertSchema, buildRuntime, frozenSourceFromPlan, main, parseArgs, progressReporter, resolveSource,
  __private: { createReplayDataDatabase },
};
