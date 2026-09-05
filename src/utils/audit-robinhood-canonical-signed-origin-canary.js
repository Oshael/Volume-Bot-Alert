'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalSignedOriginSource,
} = require('../models/robinhood-canonical-signed-origin-source');
const { createRobinhoodRpcClient } = require('../services/robinhood-ingestion-worker');
const {
  createRobinhoodCanonicalSignedOriginAudit,
} = require('../services/robinhood-canonical-signed-origin-audit');
const {
  DEFAULT_BLOCKS, DEFAULT_MIN_TRANSACTIONS, createRobinhoodCanonicalSignedOriginCanary,
} = require('../services/robinhood-canonical-signed-origin-canary');
const {
  createRobinhoodWalletSignedOriginReader,
} = require('../services/robinhood-wallet-signed-origin-reader');

function integer(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const allowed = ['--blocks=', '--min-transactions='];
  const unknown = argv.find((arg) => !allowed.some((prefix) => arg.startsWith(prefix)));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const value = (prefix) => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return Object.freeze({
    blocks: integer(value('--blocks='), DEFAULT_BLOCKS, 1, 200, '--blocks'),
    minTransactions: integer(
      value('--min-transactions='), DEFAULT_MIN_TRANSACTIONS,
      0, 1_000_000, '--min-transactions'
    ),
  });
}

async function buildCanary(options, deps = {}) {
  const database = deps.database || db;
  const env = deps.env || process.env;
  const rpcUrl = String(env.ROBINHOOD_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('ROBINHOOD_RPC_URL is required for signed-origin canary');
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)({
    publicRpcUrl: rpcUrl, rpcTimeoutMs: Number(env.ROBINHOOD_RPC_TIMEOUT_MS || 15_000),
    rpcMaxRetries: 1, rpcMinIntervalMs: 0, useAlchemy: false, useDrpc: false,
  });
  return createRobinhoodCanonicalSignedOriginCanary({
    readiness: deps.readiness || createRobinhoodCanonicalSignedOriginAudit({ database }),
    legacySource: deps.legacySource || createRobinhoodWalletSignedOriginReader({
      rpcClient, rpcBatchSize: Math.min(20, options.blocks),
      concurrency: 2, maxBlocks: options.blocks,
    }),
    canonicalSource: deps.canonicalSource
      || createRobinhoodCanonicalSignedOriginSource({ database }),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const canary = deps.canary || await buildCanary(options, deps);
  const report = await canary.inspect(options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.approved) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical signed-origin canary failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { buildCanary, main, parseArgs };
