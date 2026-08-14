require('dotenv').config();

const config = require('../../config');
const db = require('../models/db');
const { dayBounds } = require('../models/robinhood-token-transfer-persistence');
const {
  createRobinhoodWalletTransferCompactionAuditor,
} = require('../models/robinhood-wallet-transfer-compaction');
const {
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');

const COMMIT_FLAG = '--commit';
const VALUE_FLAGS = Object.freeze({
  '--day=': 'partitionDay',
  '--projection-version=': 'projectionVersion',
  '--position-projection-version=': 'positionProjectionVersion',
});

function parseArgs(argv = []) {
  const parsed = { commit: false };
  for (const arg of argv) {
    if (arg === COMMIT_FLAG) {
      if (parsed.commit) throw new Error(`${COMMIT_FLAG} cannot be repeated`);
      parsed.commit = true;
      continue;
    }
    const prefix = Object.keys(VALUE_FLAGS).find((candidate) => arg.startsWith(candidate));
    if (!prefix) throw new Error(`unknown argument: ${arg}`);
    const key = VALUE_FLAGS[prefix];
    if (parsed[key] != null) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
    const value = arg.slice(prefix.length).trim();
    if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
    parsed[key] = value;
  }
  for (const [prefix, key] of Object.entries(VALUE_FLAGS)) {
    if (!parsed[key]) throw new Error(`${prefix.slice(0, -1)} is required`);
  }
  parsed.partitionDay = dayBounds(parsed.partitionDay).from.slice(0, 10);
  return parsed;
}
function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}
function blockTag(value) {
  return `0x${quantity(value, 'blockNumber').toString(16)}`;
}
async function loadCanonicalBlockHash(rpcClient, blockNumber) {
  const expected = quantity(blockNumber, 'blockNumber');
  const block = await rpcClient.request('eth_getBlockByNumber', [blockTag(expected), false]);
  if (quantity(block?.number, 'block.number') !== expected) {
    throw new Error('RPC block does not match requested number');
  }
  const blockHash = String(block?.hash ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) throw new Error('block.hash must be 32 bytes');
  return blockHash;
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const database = deps.database || db;
  const rpcClient = deps.rpcClient || (
    deps.rpcClientFactory || createRobinhoodRpcClient
  )(deps.rpcOptions || config.robinhoodIngestionWorker);
  const providerChainIds = await (
    deps.validateChainIds || validateRobinhoodProviderChainIds
  )(rpcClient);
  const auditor = (deps.auditorFactory || createRobinhoodWalletTransferCompactionAuditor)({
    database,
    loadCanonicalBlockHash: (blockNumber) => loadCanonicalBlockHash(rpcClient, blockNumber),
  });
  const input = {
    projectionVersion: options.projectionVersion,
    positionProjectionVersion: options.positionProjectionVersion,
    partitionDay: options.partitionDay,
  };
  const result = options.commit
    ? await auditor.auditDay(input)
    : { audit: await auditor.inspectDay(input), watermark: null };
  const report = {
    mode: options.commit ? 'commit-watermark' : 'dry-run', providerChainIds, ...result,
  };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  if (!options.commit) {
    (deps.logger || console).log(`No data changed. Re-run with ${COMMIT_FLAG} after review.`);
  }
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood transfer compaction audit failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end().catch(() => {}));
}

module.exports = { COMMIT_FLAG, loadCanonicalBlockHash, main, parseArgs };
