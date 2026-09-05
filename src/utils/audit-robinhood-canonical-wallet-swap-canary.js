'use strict';

require('dotenv').config();
const db = require('../models/db');
const { createRobinhoodWalletSwapSourceReader } = require('../models/robinhood-wallet-swap-source-reader');
const { createRobinhoodCanonicalBlockSource } = require('../models/robinhood-canonical-block-source');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');
const {
  createRobinhoodCanonicalWalletSwapAudit,
} = require('../services/robinhood-canonical-wallet-swap-audit');
const {
  DEFAULT_BLOCKS, DEFAULT_MIN_OBSERVATIONS, createRobinhoodCanonicalWalletSwapCanary,
} = require('../services/robinhood-canonical-wallet-swap-canary');

function integer(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const allowed = ['--blocks=', '--min-observations='];
  const unknown = argv.find((arg) => !allowed.some((prefix) => arg.startsWith(prefix)));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const value = (prefix) => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return Object.freeze({
    blocks: integer(value('--blocks='), DEFAULT_BLOCKS, 1, 1000, '--blocks'),
    minObservations: integer(
      value('--min-observations='), DEFAULT_MIN_OBSERVATIONS,
      0, 1_000_000, '--min-observations'
    ),
  });
}

async function buildCanary(deps = {}) {
  const database = deps.database || db;
  const env = deps.env || process.env;
  const rpcUrl = String(env.ROBINHOOD_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('ROBINHOOD_RPC_URL is required for wallet-swap canary');
  const client = (deps.clientFactory || createRobinhoodRpcClient)({
    publicRpcUrl: rpcUrl,
    rpcTimeoutMs: Number(env.ROBINHOOD_RPC_TIMEOUT_MS || 15_000),
    rpcMaxRetries: 1, rpcMinIntervalMs: 0,
    useAlchemy: false, useDrpc: false, fallbackOrder: 'drpc,alchemy',
  });
  await (deps.validateChainIds || validateRobinhoodProviderChainIds)(client);
  return createRobinhoodCanonicalWalletSwapCanary({
    readiness: deps.readiness || createRobinhoodCanonicalWalletSwapAudit({ database }),
    reader: deps.reader || createRobinhoodWalletSwapSourceReader({ database }),
    canonicalSource: deps.canonicalSource || createRobinhoodCanonicalBlockSource({ database }),
    fetchLegacyBlock: (blockNumber) => client.request(
      'eth_getBlockByNumber', [`0x${BigInt(blockNumber).toString(16)}`, true]
    ),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const canary = deps.canary || await buildCanary(deps);
  const report = await canary.inspect(options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.approved) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical wallet-swap canary failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { buildCanary, main, parseArgs };
