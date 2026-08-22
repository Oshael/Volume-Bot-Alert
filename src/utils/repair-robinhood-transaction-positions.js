require('dotenv').config();

const config = require('../../config');
const db = require('../models/db');
const {
  createRobinhoodTransactionPositionRepairRepository,
} = require('../models/robinhood-transaction-position-repair');
const {
  createRobinhoodTransactionPositionRepository,
} = require('../models/robinhood-transaction-position');
const {
  createRobinhoodWalletSwapCursorRepository,
} = require('../models/robinhood-wallet-swap-cursor');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  createRobinhoodTransactionPositionResolver,
} = require('../services/robinhood-transaction-position-resolver');
const {
  executeRepair, runPreflight,
} = require('../services/robinhood-transaction-position-repair');
const {
  assertDurableSourceCoverage,
} = require('./backfill-robinhood-first-buys');
const {
  __private: { archiveRpcOptions },
} = require('./backfill-robinhood-wallet-transfers');

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--apply') values.apply = true;
    else {
      const match = argument.match(/^--([a-z-]+)=(.+)$/);
      if (!match || ![
        'from', 'through', 'range-seconds', 'concurrency', 'samples', 'max-hours',
        'max-minutes', 'batch-size',
      ].includes(match[1])) throw new Error(`unknown argument: ${argument}`);
      values[match[1]] = match[2];
    }
  }
  if (!values.from || !values.through) throw new Error('--from and --through are required');
  return Object.freeze({
    apply: values.apply === true,
    sourceFrom: values.from, sourceThrough: values.through,
    rangeSeconds: values['range-seconds'] ?? 3600,
    concurrency: values.concurrency ?? 2,
    sampleCount: values.samples ?? 3,
    maxHours: values['max-hours'] ?? 5,
    maxMinutes: values['max-minutes'] ?? 240,
    batchSize: values['batch-size'] ?? 10_000,
  });
}

async function buildRuntime(deps = {}) {
  const database = deps.database || db;
  const rpcClient = deps.rpcClient || (deps.rpcClientFactory || createEvmJsonRpcClient)(
    archiveRpcOptions(deps.env || process.env, { rpcOptions: config.robinhoodIngestionWorker })
  );
  const positions = createRobinhoodTransactionPositionRepository({ database });
  return Object.freeze({
    source: createRobinhoodTransactionPositionRepairRepository({ database }),
    resolver: createRobinhoodTransactionPositionResolver({ rpcClient, repository: positions }),
    sourceCursors: createRobinhoodWalletSwapCursorRepository({ database }),
  });
}

function progressReporter(logger) {
  return (progress) => (logger.error || logger.log).call(
    logger,
    `[TransactionPositionRepair] ${progress.ranges}/${progress.totalRanges}`
      + ` ranges; ${progress.persisted} positions persisted`
  );
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const logger = deps.logger || console;
  const runtime = deps.runtime || await (deps.runtimeFactory || buildRuntime)(deps);
  await (deps.assertCoverage || assertDurableSourceCoverage)(
    runtime.sourceCursors, options.sourceThrough
  );
  (logger.error || logger.log).call(logger, '[TransactionPositionRepair] read-only preflight...');
  const preflight = await (deps.preflight || runPreflight)(runtime, options);
  logger.log(JSON.stringify({ mode: 'preflight', ...preflight }, null, 2));
  if (!options.apply) return preflight;
  if (!preflight.approved) {
    const reason = preflight.truncatedSamples
      ? 'sample exceeded batch size; reduce --range-seconds'
      : 'projected runtime exceeds five hours';
    throw new Error(`transaction-position repair refused: ${reason}`);
  }
  const result = await (deps.execute || executeRepair)(runtime, {
    preflight, maxMinutes: options.maxMinutes, onProgress: progressReporter(logger),
  });
  logger.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('[TransactionPositionRepair] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { buildRuntime, main, parseArgs, progressReporter };
