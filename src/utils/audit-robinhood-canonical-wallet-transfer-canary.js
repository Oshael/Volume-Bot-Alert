'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalWalletTransferAudit,
} = require('../services/robinhood-canonical-wallet-transfer-audit');
const {
  DEFAULT_BLOCKS, DEFAULT_MIN_TRANSFERS, createRobinhoodCanonicalHolderCanary,
} = require('../services/robinhood-canonical-holder-canary');
const {
  resolveRobinhoodHolderLiveSource,
} = require('../services/robinhood-holder-live-source');

const DEFAULT_CONFIRMATIONS = 2;

function integer(value, fallback, minimum, maximum, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const allowed = ['--blocks=', '--min-transfers=', '--confirmations='];
  const unknown = argv.find((arg) => !allowed.some((prefix) => arg.startsWith(prefix)));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const value = (prefix) => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return Object.freeze({
    blocks: integer(value('--blocks='), DEFAULT_BLOCKS, 1, 1000, '--blocks'),
    minTransfers: integer(
      value('--min-transfers='), DEFAULT_MIN_TRANSFERS, 0, 1_000_000, '--min-transfers'
    ),
    confirmations: integer(
      value('--confirmations='), DEFAULT_CONFIRMATIONS, 0, 1000, '--confirmations'
    ),
  });
}

async function buildCanary(options, deps = {}) {
  const database = deps.database || db;
  const env = deps.env || process.env;
  const rpcTimeoutMs = Number(env.ROBINHOOD_RPC_TIMEOUT_MS || 15_000);
  const [legacy, canonical] = await Promise.all([
    resolveRobinhoodHolderLiveSource({
      sourceMode: 'rpc', providerName: 'robinhood-wallet-transfer-canary-legacy',
      rpcTimeoutMs, addressShardConcurrency: 1,
    }, { ...deps, database, env }),
    resolveRobinhoodHolderLiveSource({ sourceMode: 'canonical_journal' }, {
      ...deps, reader: undefined, database, env,
    }),
  ]);
  return createRobinhoodCanonicalHolderCanary({
    readiness: deps.readiness || createRobinhoodCanonicalWalletTransferAudit({
      database, confirmations: options.confirmations,
    }),
    legacySource: legacy.reader,
    canonicalSource: canonical.reader,
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
  console.error('Robinhood canonical wallet-transfer canary failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { DEFAULT_CONFIRMATIONS, buildCanary, main, parseArgs };
