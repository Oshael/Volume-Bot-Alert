require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletPositionRepository,
} = require('../models/robinhood-wallet-position');
const {
  createRobinhoodTransactionPositionRepository,
} = require('../models/robinhood-transaction-position');
const {
  createRobinhoodTransactionPositionResolver,
} = require('../services/robinhood-transaction-position-resolver');
const {
  runRobinhoodWalletPositionCatchup,
} = require('../services/robinhood-wallet-position-catchup');
const {
  buildRuntime: buildTransferRuntime,
  runtimeOptions,
} = require('./backfill-robinhood-wallet-transfers');

const CONFIRM_FLAG = '--confirm-catch-up-robinhood-wallet-positions';
const MAX_BLOCKS_PREFIX = '--max-blocks=';

function parseArgs(argv = []) {
  const blocks = argv.filter((arg) => arg.startsWith(MAX_BLOCKS_PREFIX));
  const unknown = argv.filter((arg) => arg !== CONFIRM_FLAG
    && !arg.startsWith(MAX_BLOCKS_PREFIX));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  if (blocks.length > 1) throw new Error('--max-blocks cannot be repeated');
  const maxBlocks = blocks.length ? Number(blocks[0].slice(MAX_BLOCKS_PREFIX.length)) : 500;
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 5000) {
    throw new Error('--max-blocks must be between 1 and 5000');
  }
  return Object.freeze({ confirm: argv.includes(CONFIRM_FLAG), maxBlocks });
}

async function buildRuntime(options = {}, deps = {}) {
  const database = deps.database || db;
  const schema = await database.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'robinhood_wallet_position_cursors'
         AND column_name = 'origin_block'
     ) AS ready,
     to_regclass('robinhood_transaction_positions') AS transaction_positions`
  );
  if (!schema.rows[0]?.ready) throw new Error('schema not ready: apply Stage 137 on the VPS');
  if (!schema.rows[0]?.transaction_positions) {
    throw new Error('schema not ready: apply Stage 139 on the VPS');
  }
  const transfer = await (deps.transferRuntimeFactory || buildTransferRuntime)(options, {
    ...deps, database,
  });
  const positionProjection = (deps.positionRepositoryFactory
    || createRobinhoodWalletPositionRepository)({ database });
  const transactionPositionRepository = (deps.transactionPositionRepositoryFactory
    || createRobinhoodTransactionPositionRepository)({ database });
  const transactionPositions = (deps.transactionPositionResolverFactory
    || createRobinhoodTransactionPositionResolver)({
    rpcClient: transfer.archiveRpcClient,
    repository: transactionPositionRepository,
  });
  return Object.freeze({
    providerChainIds: transfer.providerChainIds,
    catchupDeps: Object.freeze({
      ...transfer.tickDeps,
      transferProjection: transfer.tickDeps.projection,
      positionProjection,
      transactionPositions,
    }),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const runtime = deps.runtime || await (deps.runtimeFactory || buildRuntime)(
    deps.options || runtimeOptions(), deps
  );
  const result = await (deps.runCatchup || runRobinhoodWalletPositionCatchup)(
    runtime.catchupDeps, { maxBlocks: args.maxBlocks, commit: args.confirm }
  );
  const report = Object.freeze({
    mode: args.confirm ? 'commit-bounded-range' : 'dry-run',
    providerChainIds: runtime.providerChainIds, result,
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  if (!args.confirm) {
    (deps.logger || console).log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
  }
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood unified wallet-position catch-up failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, buildRuntime, main, parseArgs };
