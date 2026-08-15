require('dotenv').config();

const config = require('../../config');
const db = require('../models/db');
const {
  runRobinhoodWalletTransferBackfillCommit,
  runRobinhoodWalletTransferBackfillDryRun,
} = require('../services/robinhood-wallet-transfer-backfill-tick');
const {
  buildRobinhoodWalletTransferRuntime,
} = require('../services/robinhood-wallet-transfer-runtime');

const CONFIRM_FLAG = '--confirm-backfill-robinhood-wallet-transfers';
const MAX_BLOCKS_PREFIX = '--max-blocks=';

function maxBlocks(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('--max-blocks must be between 1 and 5000');
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = argv.filter((arg) => arg.startsWith(MAX_BLOCKS_PREFIX));
  const unknown = argv.filter((arg) => (
    arg !== CONFIRM_FLAG && !arg.startsWith(MAX_BLOCKS_PREFIX)
  ));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  if (values.length > 1) throw new Error('--max-blocks cannot be repeated');
  if (argv.filter((arg) => arg === CONFIRM_FLAG).length > 1) {
    throw new Error(`${CONFIRM_FLAG} cannot be repeated`);
  }
  return Object.freeze({
    confirm: argv.includes(CONFIRM_FLAG),
    maxBlocks: values.length ? maxBlocks(values[0].slice(MAX_BLOCKS_PREFIX.length)) : 250,
  });
}

function runtimeOptions() {
  const live = config.robinhoodWalletTransferLiveWorker;
  return Object.freeze({
    addressShardConcurrency: live.addressShardConcurrency,
    blockEvidenceBatchSize: live.blockEvidenceBatchSize,
    endpointRoleBatchSize: live.endpointRoleBatchSize,
    rpcOptions: config.robinhoodIngestionWorker,
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const runtime = deps.runtime || await (
    deps.runtimeFactory || buildRobinhoodWalletTransferRuntime
  )(deps.options || runtimeOptions(), deps);
  const execute = args.confirm
    ? (deps.runCommit || runRobinhoodWalletTransferBackfillCommit)
    : (deps.runDryRun || runRobinhoodWalletTransferBackfillDryRun);
  const result = await execute(runtime.tickDeps, {
    maxBlocks: args.maxBlocks, now: deps.now,
  });
  const report = Object.freeze({
    mode: args.confirm ? 'commit-one-range' : 'dry-run',
    providerChainIds: runtime.providerChainIds, result,
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  if (!args.confirm) {
    (deps.logger || console).log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
  }
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood wallet-transfer backfill failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, main, parseArgs, runtimeOptions };
