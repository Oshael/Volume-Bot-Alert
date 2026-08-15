require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletEndpointRoleRepository,
} = require('../models/robinhood-wallet-endpoint-role');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  runRobinhoodWalletEndpointRoleBackfill,
} = require('../services/robinhood-wallet-endpoint-role-backfill');
const {
  createRobinhoodWalletTransferEndpointRoleReader,
} = require('../services/robinhood-wallet-transfer-endpoint-roles');

const CONFIRM_FLAG = '--confirm-backfill-robinhood-wallet-endpoint-roles';
const LIMIT_PREFIX = '--limit=';
const BATCH_PREFIX = '--batch-size=';
const EXPECTED_CHAIN_ID = 4663n;

function boundedArgument(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const limits = argv.filter((arg) => arg.startsWith(LIMIT_PREFIX));
  const batches = argv.filter((arg) => arg.startsWith(BATCH_PREFIX));
  const unknown = argv.filter((arg) => (
    arg !== CONFIRM_FLAG && !arg.startsWith(LIMIT_PREFIX) && !arg.startsWith(BATCH_PREFIX)
  ));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  if (limits.length > 1) throw new Error('--limit cannot be repeated');
  if (batches.length > 1) throw new Error('--batch-size cannot be repeated');
  if (argv.filter((arg) => arg === CONFIRM_FLAG).length > 1) {
    throw new Error(`${CONFIRM_FLAG} cannot be repeated`);
  }
  return Object.freeze({
    confirm: argv.includes(CONFIRM_FLAG),
    limit: limits.length
      ? boundedArgument(limits[0].slice(LIMIT_PREFIX.length), 1, 1000, '--limit') : 100,
    batchSize: batches.length
      ? boundedArgument(batches[0].slice(BATCH_PREFIX.length), 1, 100, '--batch-size') : 50,
  });
}

function requiredEnvironment(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

async function buildRuntime(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const rpcUrl = requiredEnvironment(env, 'RH_NODE_RPC_URL');
  requiredEnvironment(env, 'DATABASE_URL');
  const database = deps.database || db;
  const schema = await database.query(
    `SELECT to_regclass('robinhood_token_transfer_events') AS events,
            to_regclass('robinhood_wallet_endpoint_roles') AS roles`
  );
  if (!schema.rows[0]?.events || !schema.rows[0]?.roles) {
    throw new Error('schema not ready: apply Stages 128 and 135 on the VPS');
  }
  const rpcClient = deps.rpcClient || (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-pc-archive', url: rpcUrl }],
    timeoutMs: 30_000, maxRetries: 1,
  });
  const chainId = BigInt(await rpcClient.request('eth_chainId', []));
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`unexpected Robinhood chain ID ${chainId}`);
  return Object.freeze({
    provider: 'robinhood-pc-archive',
    repository: (deps.repositoryFactory || createRobinhoodWalletEndpointRoleRepository)({ database }),
    reader: (deps.readerFactory || createRobinhoodWalletTransferEndpointRoleReader)({
      rpcClient, batchSize: options.batchSize,
    }),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const runtime = deps.runtime || await (deps.runtimeFactory || buildRuntime)(args, deps);
  const result = await (deps.runBackfill || runRobinhoodWalletEndpointRoleBackfill)(runtime, {
    limit: args.limit, commit: args.confirm,
  });
  const report = Object.freeze({
    mode: args.confirm ? 'confirmed' : 'dry-run', provider: runtime.provider, result,
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  if (!args.confirm) {
    (deps.logger || console).log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
  }
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood wallet endpoint-role backfill failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, buildRuntime, main, parseArgs };
