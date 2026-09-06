'use strict';

require('dotenv').config();
const db = require('../models/db');
const { createRobinhoodBundleFundingReader } = require('../services/robinhood-bundle-funding-reader');
const {
  createRobinhoodCanonicalBundleFundingReader,
} = require('../services/robinhood-canonical-bundle-funding-reader');
const { createRobinhoodRpcClient } = require('../services/robinhood-ingestion-worker');
const {
  createRobinhoodCanonicalBundleFundingAudit,
} = require('../services/robinhood-canonical-bundle-funding-audit');
const {
  DEFAULT_BLOCKS, DEFAULT_MIN_TRANSFERS, createRobinhoodCanonicalBundleFundingCanary,
} = require('../services/robinhood-canonical-bundle-funding-canary');

function integer(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const allowed = ['--blocks=', '--min-transfers='];
  const unknown = argv.find((arg) => !allowed.some((prefix) => arg.startsWith(prefix)));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const value = (prefix) => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return Object.freeze({
    blocks: integer(value('--blocks='), DEFAULT_BLOCKS, 1, 100, '--blocks'),
    minTransfers: integer(
      value('--min-transfers='), DEFAULT_MIN_TRANSFERS, 0, 1_000_000, '--min-transfers'
    ),
  });
}

function buildCanary(deps = {}) {
  const database = deps.database || db;
  const env = deps.env || process.env;
  const rpcUrl = String(env.ROBINHOOD_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('ROBINHOOD_RPC_URL is required for bundle-funding canary');
  const client = (deps.clientFactory || createRobinhoodRpcClient)({
    publicRpcUrl: rpcUrl, rpcTimeoutMs: Number(env.ROBINHOOD_RPC_TIMEOUT_MS || 15_000),
    rpcMaxRetries: 1, rpcMinIntervalMs: 0, useAlchemy: false, useDrpc: false,
    fallbackOrder: 'drpc,alchemy',
  });
  return createRobinhoodCanonicalBundleFundingCanary({
    readiness: deps.readiness || createRobinhoodCanonicalBundleFundingAudit({ database }),
    legacyReader: deps.legacyReader || createRobinhoodBundleFundingReader({
      rpcClient: client, candidateWallets: [],
    }),
    canonicalReader: deps.canonicalReader || createRobinhoodCanonicalBundleFundingReader({
      database, candidateWallets: [],
    }),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const canary = deps.canary || buildCanary(deps);
  const report = await canary.inspect(options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.approved) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical bundle-funding canary failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { buildCanary, main, parseArgs };
