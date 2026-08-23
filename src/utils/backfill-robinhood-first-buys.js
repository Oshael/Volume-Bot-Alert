const db = require('../models/db');
const {
  createRobinhoodFirstBuyBackfillRepository,
} = require('../models/robinhood-first-buy-backfill');
const {
  createRobinhoodWalletTokenFirstBuyRepository,
} = require('../models/robinhood-wallet-token-first-buy');
const {
  createRobinhoodWalletSwapCursorRepository,
} = require('../models/robinhood-wallet-swap-cursor');
const {
  executeBackfill, runPreflight,
} = require('../services/robinhood-first-buy-backfill-runner');
const {
  __private: { exclusiveCheckpointTime },
} = require('../services/robinhood-first-buy-live-runner');

const VALUE_ARGUMENTS = new Set([
  'from', 'through', 'range-seconds', 'concurrency', 'samples', 'max-hours', 'run-id',
  'statement-timeout-ms',
]);

function argumentValues(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--apply') values.apply = true;
    else if (argument === '--retry-failed') values.retryFailed = true;
    else {
      const match = argument.match(/^--([a-z-]+)=(.+)$/);
      if (!match || !VALUE_ARGUMENTS.has(match[1])) throw new Error(`unknown argument: ${argument}`);
      values[match[1]] = match[2];
    }
  }
  return values;
}

function validateCombination(values) {
  if (!values['run-id'] && (!values.from || !values.through)) {
    throw new Error('--from and --through are required unless --run-id is provided');
  }
  if (values['run-id'] && (values.from || values.through || values['range-seconds'])) {
    throw new Error('--run-id cannot be combined with source range arguments');
  }
  if (values.retryFailed && (!values['run-id'] || !values.apply)) {
    throw new Error('--retry-failed requires --run-id and --apply');
  }
}

function parseStatementTimeout(value) {
  const statementTimeoutMs = Number(value ?? 120_000);
  if (!Number.isSafeInteger(statementTimeoutMs)
    || statementTimeoutMs < 120_000 || statementTimeoutMs > 900_000) {
    throw new Error('--statement-timeout-ms must be between 120000 and 900000');
  }
  return statementTimeoutMs;
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = argumentValues(argv);
  validateCombination(values);
  const statementTimeoutMs = parseStatementTimeout(values['statement-timeout-ms']);
  return Object.freeze({
    apply: values.apply === true, retryFailed: values.retryFailed === true,
    runId: values['run-id'], statementTimeoutMs,
    sourceFrom: values.from, sourceThrough: values.through,
    rangeSeconds: values['range-seconds'] ?? 3600,
    concurrency: values.concurrency ?? 2, sampleCount: values.samples ?? 3,
    maxHours: values['max-hours'] ?? 5,
  });
}

function progressReporter(logger = console) {
  let previous = '';
  return (progress) => {
    if (!progress) return;
    const message = `[FirstBuyBackfill] ${progress.status} ${progress.completed}/${progress.total}`
      + ` (${progress.progressPct}%) eta=${progress.etaSeconds ?? 'calculating'}s`;
    if (message !== previous) (logger.error || logger.log).call(logger, message);
    previous = message;
  };
}

async function assertDurableSourceCoverage(sourceCursors, sourceThrough) {
  const gate = await sourceCursors.loadRetentionGate();
  if (!gate?.valid || gate.seed?.lifecycleState !== 'complete') {
    const reason = gate?.valid ? 'seed_not_complete' : (gate?.reason || 'unknown');
    const error = new Error(`wallet-swap source is not durable: ${reason}`);
    error.code = 'first_buy_source_unavailable';
    throw error;
  }
  const durableThrough = exclusiveCheckpointTime(gate.live.checkpointTimestamp);
  const requestedThrough = new Date(sourceThrough);
  if (!Number.isFinite(requestedThrough.getTime())) throw new Error('sourceThrough must be an instant');
  if (requestedThrough > new Date(durableThrough)) {
    const error = new Error(`sourceThrough exceeds durable wallet swaps (${durableThrough})`);
    error.code = 'first_buy_source_ahead';
    throw error;
  }
  return Object.freeze({ durableThrough, completeThroughBlock: gate.completeThroughBlock });
}

async function main(deps = {}) {
  const options = deps.options || parseArgs(deps.argv);
  const database = deps.database || db;
  const logger = deps.logger || console;
  const backfillRepository = deps.backfillRepository
    || createRobinhoodFirstBuyBackfillRepository({ database });
  const firstBuyRepository = deps.firstBuyRepository
    || createRobinhoodWalletTokenFirstBuyRepository({
      database, statementTimeoutMs: options.statementTimeoutMs,
    });
  const sourceCursors = deps.sourceCursors
    || createRobinhoodWalletSwapCursorRepository({ database });
  let source = options;
  if (options.runId) {
    const run = await backfillRepository.getRun(options.runId);
    if (!run) throw new Error('first-buy backfill run was not found');
    source = { ...options, ...run };
  }
  await assertDurableSourceCoverage(sourceCursors, source.sourceThrough);
  (logger.error || logger.log).call(logger, '[FirstBuyBackfill] mandatory read-only preflight...');
  const preflight = await runPreflight({ firstBuyRepository, now: deps.now }, source);
  logger.log(JSON.stringify({ mode: 'preflight', ...preflight }, null, 2));
  if (!options.apply) return preflight;
  if (!preflight.approved) {
    const error = new Error('preflight refused write; reduce range size/concurrency load');
    error.code = 'first_buy_backfill_preflight_refused';
    throw error;
  }
  const result = await executeBackfill({
    backfillRepository, firstBuyRepository, sleep: deps.sleep,
  }, {
    preflight, runId: options.runId, retryFailed: options.retryFailed,
    onProgress: progressReporter(logger),
    onRun: ({ runId, status, requeued }) => (logger.error || logger.log).call(
      logger, `[FirstBuyBackfill] run-id=${runId} status=${status} requeued=${requeued}`
    ),
  });
  logger.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('[FirstBuyBackfill] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end());

module.exports = { assertDurableSourceCoverage, main, parseArgs, progressReporter };
