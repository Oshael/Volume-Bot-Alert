const db = require('../models/db');
const {
  createRobinhoodFirstBuyBackfillRepository,
} = require('../models/robinhood-first-buy-backfill');
const {
  createRobinhoodWalletTokenFirstBuyRepository,
} = require('../models/robinhood-wallet-token-first-buy');
const {
  executeBackfill, runPreflight,
} = require('../services/robinhood-first-buy-backfill-runner');

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--apply') values.apply = true;
    else {
      const match = argument.match(/^--([a-z-]+)=(.+)$/);
      if (!match || ![
        'from', 'through', 'range-seconds', 'concurrency', 'samples', 'max-hours', 'run-id',
      ].includes(match[1])) throw new Error(`unknown argument: ${argument}`);
      values[match[1]] = match[2];
    }
  }
  if (!values['run-id'] && (!values.from || !values.through)) {
    throw new Error('--from and --through are required unless --run-id is provided');
  }
  if (values['run-id'] && (values.from || values.through || values['range-seconds'])) {
    throw new Error('--run-id cannot be combined with source range arguments');
  }
  return Object.freeze({
    apply: values.apply === true, runId: values['run-id'],
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

async function main(deps = {}) {
  const options = deps.options || parseArgs(deps.argv);
  const database = deps.database || db;
  const logger = deps.logger || console;
  const backfillRepository = deps.backfillRepository
    || createRobinhoodFirstBuyBackfillRepository({ database });
  const firstBuyRepository = deps.firstBuyRepository
    || createRobinhoodWalletTokenFirstBuyRepository({ database });
  let source = options;
  if (options.runId) {
    const run = await backfillRepository.getRun(options.runId);
    if (!run) throw new Error('first-buy backfill run was not found');
    source = { ...options, ...run };
  }
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
    preflight, runId: options.runId, onProgress: progressReporter(logger),
    onRun: ({ runId, status }) => (logger.error || logger.log).call(
      logger, `[FirstBuyBackfill] run-id=${runId} status=${status}`
    ),
  });
  logger.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('[FirstBuyBackfill] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end());

module.exports = { main, parseArgs, progressReporter };
