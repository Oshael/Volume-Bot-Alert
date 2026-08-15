require('dotenv').config();

const config = require('../../config');
const db = require('../models/db');
const {
  createRobinhoodWalletEndpointRoleRepository,
} = require('../models/robinhood-wallet-endpoint-role');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  runRobinhoodWalletTransferBackfillDryRun,
} = require('../services/robinhood-wallet-transfer-backfill-tick');
const {
  buildRobinhoodWalletTransferRuntime,
} = require('../services/robinhood-wallet-transfer-runtime');
const {
  createRobinhoodWalletTransferEndpointRoleReader,
} = require('../services/robinhood-wallet-transfer-endpoint-roles');
const {
  createRobinhoodWalletTransferRoleHydrator,
} = require('../services/robinhood-wallet-transfer-role-hydration');
const {
  runRobinhoodWalletTransferBackfill,
} = require('../services/robinhood-wallet-transfer-backfill-runner');

const CONFIRM_FLAG = '--confirm-backfill-robinhood-wallet-transfers';
const MAX_BLOCKS_PREFIX = '--max-blocks=';
const MAX_RANGES_PREFIX = '--max-ranges=';
const PAUSE_MS_PREFIX = '--pause-ms=';

function bounded(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const blocks = argv.filter((arg) => arg.startsWith(MAX_BLOCKS_PREFIX));
  const ranges = argv.filter((arg) => arg.startsWith(MAX_RANGES_PREFIX));
  const pauses = argv.filter((arg) => arg.startsWith(PAUSE_MS_PREFIX));
  const unknown = argv.filter((arg) => (
    arg !== CONFIRM_FLAG && !arg.startsWith(MAX_BLOCKS_PREFIX)
    && !arg.startsWith(MAX_RANGES_PREFIX) && !arg.startsWith(PAUSE_MS_PREFIX)
  ));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  if (blocks.length > 1) throw new Error('--max-blocks cannot be repeated');
  if (ranges.length > 1) throw new Error('--max-ranges cannot be repeated');
  if (pauses.length > 1) throw new Error('--pause-ms cannot be repeated');
  if (argv.filter((arg) => arg === CONFIRM_FLAG).length > 1) {
    throw new Error(`${CONFIRM_FLAG} cannot be repeated`);
  }
  const parsed = Object.freeze({
    confirm: argv.includes(CONFIRM_FLAG),
    maxBlocks: blocks.length
      ? bounded(blocks[0].slice(MAX_BLOCKS_PREFIX.length), 1, 5000, '--max-blocks') : 250,
    maxRanges: ranges.length
      ? bounded(ranges[0].slice(MAX_RANGES_PREFIX.length), 1, 10_000, '--max-ranges') : 1,
    pauseMs: pauses.length
      ? bounded(pauses[0].slice(PAUSE_MS_PREFIX.length), 0, 60_000, '--pause-ms') : 250,
  });
  if (!parsed.confirm && (parsed.maxRanges !== 1 || pauses.length)) {
    throw new Error('--max-ranges and --pause-ms require the confirmation flag');
  }
  return parsed;
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

function requiredEnvironment(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function archiveRpcOptions(env, options = {}) {
  return Object.freeze({
    providers: [Object.freeze({
      name: 'robinhood-pc-archive',
      url: requiredEnvironment(env, 'RH_NODE_RPC_URL'),
      minRequestIntervalMs: options.rpcOptions?.archiveRpcMinIntervalMs,
    })],
    timeoutMs: 30_000, maxRetries: 1,
  });
}

async function buildRuntime(options = {}, deps = {}) {
  const env = deps.env || process.env;
  requiredEnvironment(env, 'DATABASE_URL');
  const database = deps.database || db;
  const schema = await database.query(
    "SELECT to_regclass('robinhood_wallet_endpoint_roles') AS roles"
  );
  if (!schema.rows[0]?.roles) throw new Error('schema not ready: apply Stage 135 on the VPS');
  const rpcClient = deps.rpcClient || (deps.rpcClientFactory || createEvmJsonRpcClient)(
    archiveRpcOptions(env, options)
  );
  const runtime = await (deps.transferRuntimeFactory || buildRobinhoodWalletTransferRuntime)(
    options, { ...deps, database, rpcClient }
  );
  const repository = (deps.roleRepositoryFactory
    || createRobinhoodWalletEndpointRoleRepository)({ database });
  const reader = (deps.roleReaderFactory
    || createRobinhoodWalletTransferEndpointRoleReader)({
    rpcClient, batchSize: options.endpointRoleBatchSize,
  });
  const endpointRoles = (deps.hydratorFactory
    || createRobinhoodWalletTransferRoleHydrator)({ repository, reader });
  return Object.freeze({
    ...runtime,
    tickDeps: Object.freeze({ ...runtime.tickDeps, endpointRoles }),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const runtime = deps.runtime || await (
    deps.runtimeFactory || buildRuntime
  )(deps.options || runtimeOptions(), deps);
  const result = args.confirm
    ? await (deps.runBackfill || runRobinhoodWalletTransferBackfill)({
      maxBlocks: args.maxBlocks, maxRanges: args.maxRanges,
      pauseMs: args.pauseMs, now: deps.now,
    }, { tickDeps: runtime.tickDeps, runCommit: deps.runCommit,
      leaseStore: deps.leaseStore, sleep: deps.sleep,
      setInterval: deps.setInterval, clearInterval: deps.clearInterval })
    : await (deps.runDryRun || runRobinhoodWalletTransferBackfillDryRun)(runtime.tickDeps, {
      maxBlocks: args.maxBlocks, now: deps.now,
    });
  const report = Object.freeze({
    mode: args.confirm ? 'commit-bounded-ranges' : 'dry-run',
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

module.exports = {
  CONFIRM_FLAG, buildRuntime, main, parseArgs, runtimeOptions,
  __private: { archiveRpcOptions },
};
