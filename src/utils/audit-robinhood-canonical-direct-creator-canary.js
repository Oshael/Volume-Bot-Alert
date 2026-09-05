'use strict';

require('dotenv').config();
const db = require('../models/db');
const { createRobinhoodRpcClient, validateRobinhoodProviderChainIds } = require('../services/robinhood-ingestion-worker');
const { __private: { scanBlock } } = require('../services/robinhood-direct-creator-worker');
const { createRobinhoodCanonicalDirectCreatorAudit } = require('../services/robinhood-canonical-direct-creator-audit');
const {
  DEFAULT_BLOCKS, DEFAULT_CONCURRENCY, DEFAULT_MIN_DEPLOYMENTS,
  createCanonicalReader, createRobinhoodCanonicalDirectCreatorCanary,
} = require('../services/robinhood-canonical-direct-creator-canary');

function integer(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const allowed = ['--blocks=', '--min-deployments=', '--concurrency='];
  const unknown = argv.find((arg) => !allowed.some((prefix) => arg.startsWith(prefix)));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const value = (prefix) => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return Object.freeze({
    blocks: integer(value('--blocks='), DEFAULT_BLOCKS, 1, 200, '--blocks'),
    minDeployments: integer(
      value('--min-deployments='), DEFAULT_MIN_DEPLOYMENTS, 0, 100_000, '--min-deployments'
    ),
    concurrency: integer(value('--concurrency='), DEFAULT_CONCURRENCY, 1, 16, '--concurrency'),
  });
}

async function buildCanary(deps = {}) {
  const database = deps.database || db;
  const env = deps.env || process.env;
  const rpcUrl = String(env.ROBINHOOD_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('ROBINHOOD_RPC_URL is required for direct-creator canary');
  const client = (deps.clientFactory || createRobinhoodRpcClient)({
    publicRpcUrl: rpcUrl, rpcTimeoutMs: Number(env.ROBINHOOD_RPC_TIMEOUT_MS || 15_000),
    rpcMaxRetries: 1, rpcMinIntervalMs: 0, useAlchemy: false, useDrpc: false,
    fallbackOrder: 'drpc,alchemy',
  });
  await (deps.validateChainIds || validateRobinhoodProviderChainIds)(client);
  return createRobinhoodCanonicalDirectCreatorCanary({
    readiness: deps.readiness || createRobinhoodCanonicalDirectCreatorAudit({ database }),
    canonicalReader: deps.canonicalReader || createCanonicalReader(database),
    scanLegacyBlock: (blockNumber) => scanBlock(client, blockNumber),
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
  console.error('Robinhood canonical direct-creator canary failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { buildCanary, main, parseArgs };
