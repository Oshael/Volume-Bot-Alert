require('dotenv').config();

const db = require('../models/db');
const { createRobinhoodBundleFundingBackfillRepository } = require(
  '../models/robinhood-bundle-funding-backfill'
);
const { createRobinhoodBundleFundingCandidateSource } = require(
  '../models/robinhood-bundle-funding-candidate-source'
);
const { executeBundleFundingBackfill } = require(
  '../services/robinhood-bundle-funding-backfill-runner'
);
const { createRobinhoodBundleFundingReader, preflightBundleFunding } = require(
  '../services/robinhood-bundle-funding-reader'
);
const { planBundleFundingScan } = require('../services/robinhood-bundle-funding-scan-plan');
const { archiveClient } = require('./preflight-robinhood-bundle-funding');

const VALUE_ARGUMENTS = new Set([
  'lookback-blocks', 'source-from-block', 'statement-timeout-ms', 'batch-blocks',
  'concurrency', 'samples', 'max-hours', 'max-minutes', 'run-id', 'max-attempts',
]);

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
      if (values[key]) throw new Error(`repeated argument: ${argument}`);
      values[key] = true;
    } else {
      const match = argument.match(/^--([a-z-]+)=(.+)$/);
      if (!match || !VALUE_ARGUMENTS.has(match[1]) || values[match[1]] != null) {
        throw new Error(`unknown or repeated argument: ${argument}`);
      }
      values[match[1]] = match[2];
    }
  }
  return values;
}

function validateCombination(values) {
  if (!values['run-id'] && values['lookback-blocks'] == null) {
    throw new Error('--lookback-blocks is required unless --run-id is provided');
  }
  if (values['run-id'] && (values['lookback-blocks'] || values['source-from-block']
      || values['batch-blocks'] || values.concurrency || values.samples)) {
    throw new Error('--run-id cannot be combined with planning arguments');
  }
  if (values.retryFailed && (!values['run-id'] || !values.apply)) {
    throw new Error('--retry-failed requires --run-id and --apply');
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = argumentValues(argv);
  validateCombination(values);
  const maxHours = Number(values['max-hours'] ?? 5);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > 5) {
    throw new Error('--max-hours must be greater than 0 and at most 5');
  }
  const parsed = Object.freeze({
    apply: values.apply === true, retryFailed: values.retryFailed === true,
    runId: values['run-id'] == null ? null : String(bounded(
      values['run-id'], null, 1, Number.MAX_SAFE_INTEGER, '--run-id'
    )),
    lookbackBlocks: values['lookback-blocks'] == null ? null : bounded(
      values['lookback-blocks'], null, 0, 50_000_000, '--lookback-blocks'
    ),
    sourceFromBlock: String(bounded(
      values['source-from-block'], 0, 0, 50_000_000, '--source-from-block'
    )),
    statementTimeoutMs: bounded(
      values['statement-timeout-ms'], 120_000, 1_000, 900_000, '--statement-timeout-ms'
    ),
    batchBlocks: bounded(values['batch-blocks'], 50, 1, 100, '--batch-blocks'),
    concurrency: bounded(values.concurrency, 16, 1, 16, '--concurrency'),
    sampleCount: bounded(values.samples, 32, 1, 64, '--samples'), maxHours,
    maxMinutes: bounded(values['max-minutes'], 285, 1, 300, '--max-minutes'),
    maxAttempts: bounded(values['max-attempts'], 5, 1, 20, '--max-attempts'),
  });
  if (!parsed.runId && parsed.sampleCount < parsed.concurrency) {
    throw new Error('--samples must be greater than or equal to --concurrency');
  }
  return parsed;
}

async function assertSchema(database) {
  const result = await database.query(`SELECT
    to_regclass('robinhood_bundle_funding_backfill_runs') AS runs,
    to_regclass('robinhood_native_funding_events') AS events`);
  if (!result.rows[0]?.runs || !result.rows[0]?.events) {
    throw new Error('Stage 167 is required; run node src/utils/db-init-stage167.js');
  }
}

function reporter(logger) {
  let previous = '';
  return (progress) => {
    if (!progress) return;
    const message = `[BundleFunding] ${progress.status} ${progress.completed}/${progress.total}`
      + ` pending=${progress.pending} leased=${progress.leased} failed=${progress.failed}`;
    if (message !== previous) (logger.error || logger.log).call(logger, message);
    previous = message;
  };
}

async function prepare(options, deps, database, rpcClient) {
  const source = deps.source || createRobinhoodBundleFundingCandidateSource({
    database, statementTimeoutMs: options.statementTimeoutMs,
  });
  const loaded = await source.load();
  if (!loaded.ready) throw new Error(`bundle funding source unavailable: ${loaded.reason}`);
  const plan = (deps.planner || planBundleFundingScan)({
    sourceFromBlock: options.sourceFromBlock,
    sourceThroughBlock: loaded.completeThroughBlock,
    lookbackBlocks: options.lookbackBlocks, candidates: loaded.candidates,
  });
  const reader = deps.reader || createRobinhoodBundleFundingReader({
    rpcClient, candidateWallets: plan.candidates.map(({ walletAddress }) => walletAddress),
  });
  const preflight = await (deps.preflight || preflightBundleFunding)({
    ranges: plan.ranges, sourceThroughBlock: plan.sourceThroughBlock,
    batchBlocks: options.batchBlocks, concurrency: options.concurrency,
    sampleCount: options.sampleCount, maxHours: options.maxHours,
  }, { reader, now: deps.now });
  return { loaded, plan, preflight, reader };
}

function readOnlyReport(existingRun, prepared) {
  if (existingRun) return {
    mode: 'resume-read-only', runId: existingRun.id, status: existingRun.status,
    sourceThroughBlock: existingRun.sourceThroughBlock,
  };
  return {
    mode: 'preflight-read-only', approved: prepared.preflight.approved,
    anchorCoverageComplete: prepared.loaded.anchorCoverageComplete,
    missingAnchorTokens: prepared.loaded.missingAnchorTokens,
    ruleVersion: prepared.plan.ruleVersion, lookbackBlocks: prepared.plan.lookbackBlocks,
    candidateTokens: prepared.plan.candidateTokens,
    candidateWallets: prepared.plan.candidateWallets,
    mergedRanges: prepared.plan.mergedRanges, blocksToScan: prepared.plan.blocksToScan,
    ...prepared.preflight,
  };
}

function runtime(deps, database, env) {
  const repository = deps.repository
    || createRobinhoodBundleFundingBackfillRepository({ database });
  const rpcClient = deps.rpcClient
    || (deps.reader ? null : archiveClient(env, deps.rpcClientFactory));
  return { repository, rpcClient };
}

function executionReader(prepared, deps, rpcClient) {
  if (prepared) return prepared.reader;
  if (deps.reader) return deps.reader;
  return createRobinhoodBundleFundingReader({ rpcClient, candidateWallets: [] });
}

async function apply(options, prepared, deps, context) {
  const { database, logger, repository, reader } = context;
  await (deps.assertSchema || assertSchema)(database);
  const result = await (deps.execute || executeBundleFundingBackfill)({
    repository, reader, now: deps.now, sleep: deps.sleep,
  }, {
    runId: options.runId, retryFailed: options.retryFailed,
    plan: prepared?.plan, preflight: prepared?.preflight,
    maxMinutes: options.maxMinutes, maxAttempts: options.maxAttempts,
    onRun: (run) => logger.error(`[BundleFunding] run-id=${run.runId}`),
    onProgress: reporter(logger),
  });
  logger.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
  return result;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const { database = db, env = process.env, logger = console } = deps;
  if (!String(env.DATABASE_URL || '').trim()) throw new Error('missing required env DATABASE_URL');
  const { repository, rpcClient } = runtime(deps, database, env);
  const existingRun = options.runId ? await repository.getRun(options.runId) : null;
  if (options.runId && !existingRun) throw new Error('bundle funding run was not found');
  let prepared = null;
  if (!existingRun) prepared = await prepare(options, deps, database, rpcClient);
  const reader = executionReader(prepared, deps, rpcClient);
  const report = readOnlyReport(existingRun, prepared);
  logger.log(JSON.stringify(report, null, 2));
  if (!options.apply) return report;
  return apply(options, prepared, deps, { database, logger, repository, reader });
}

if (require.main === module) main().catch((error) => {
  console.error('[BundleFunding] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { assertSchema, main, parseArgs };
