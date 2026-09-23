'use strict';

require('dotenv').config();

const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createRobinhoodWalletTransferLiveSourceRepository } =
  require('../models/robinhood-wallet-transfer-live-source');
const { createRobinhoodTransferClassifier } =
  require('../services/robinhood-transfer-classifier');
const { compareReceipt } = require('./audit-robinhood-wallet-transfer-pilot-parity');

const DAY = '2026-07-19';
const PARTITION = 'public.robinhood_token_transfer_events_2026_07_19';
const VERSION = 'rh_transfer_v1';
const SAMPLE_PERCENT = 1;
const PER_KIND = 3;

function parseArgs(argv) {
  if (argv.length !== 1 || argv[0] !== `--day=${DAY}`) {
    throw new Error(`decision audit requires --day=${DAY}`);
  }
}

async function readWatermark(database) {
  const mark = (await database.query(
    `SELECT version::text, checkpoint_block::text, checkpoint_hash,
            raw_event_count::text, lifecycle_state
       FROM robinhood_wallet_transfer_compaction_watermarks
      WHERE chain='robinhood' AND projection_version=$1 AND partition_day=$2::date`,
    [VERSION, DAY]
  )).rows[0];
  if (!mark || mark.lifecycle_state !== 'verified'
      || !/^0x[0-9a-f]{64}$/.test(mark.checkpoint_hash || '')) {
    throw new Error('verified pilot watermark is unavailable');
  }
  return mark;
}

async function readPopulation(database, mark) {
  const rows = (await database.query(
    `SELECT transfer_kind, COUNT(*)::text AS events
       FROM ${PARTITION} WHERE chain='robinhood'
      GROUP BY transfer_kind ORDER BY transfer_kind`
  )).rows;
  const count = rows.reduce((sum, row) => sum + BigInt(row.events), 0n);
  if (count.toString() !== mark.raw_event_count) {
    throw new Error('pilot classification population differs from watermark');
  }
  return rows;
}

async function readSample(database) {
  return (await database.query(
    `WITH sampled AS (
       SELECT transaction_hash, log_index, block_time, block_number::text,
              block_hash, transaction_index, token_address, from_wallet,
              to_wallet, amount_raw::text, transfer_kind, classification_version,
              ROW_NUMBER() OVER (PARTITION BY transfer_kind
                ORDER BY md5(transaction_hash || ':' || log_index::text)) AS pick
         FROM ${PARTITION} TABLESAMPLE BERNOULLI (${SAMPLE_PERCENT}) REPEATABLE (1907)
        WHERE chain='robinhood'
     ) SELECT * FROM sampled WHERE pick <= ${PER_KIND}
      ORDER BY transfer_kind, pick`
  )).rows;
}

function sourceInput(rows) {
  const blocks = rows.map((row) => BigInt(row.block_number));
  const times = rows.map((row) => new Date(row.block_time).getTime());
  return { fromBlock: String(blocks.reduce((a, b) => a < b ? a : b)),
    toBlock: String(blocks.reduce((a, b) => a > b ? a : b)),
    fromTime: new Date(Math.min(...times)).toISOString(),
    toTime: new Date(Math.max(...times)).toISOString(),
    transactionHashes: [...new Set(rows.map((row) => row.transaction_hash))],
    endpointAddresses: [...new Set(rows.flatMap((row) => [row.from_wallet, row.to_wallet]))] };
}

function classifierFor(context) {
  return createRobinhoodTransferClassifier({
    poolAddresses: context.poolAddresses,
    routerAddresses: context.routerAddresses,
    contractAddresses: context.contractAddresses,
    contractRoleEvidence: context.contractRoleEvidence,
    walletAddresses: context.walletAddresses,
  });
}

async function compareArchiveReceipts(rpc, rows) {
  const hashes = [...new Set(rows.map((row) => row.transaction_hash))];
  const receipts = await rpc.requestBatch(hashes.map((hash) => ({
    method: 'eth_getTransactionReceipt', params: [hash],
  })));
  if (!Array.isArray(receipts) || receipts.length !== hashes.length) {
    throw new Error('Archive receipt sample is incomplete');
  }
  const byHash = new Map(hashes.map((hash, index) => [hash, receipts[index]]));
  for (const row of rows) {
    if (!compareReceipt(row, byHash.get(row.transaction_hash))) {
      throw new Error(`Archive receipt differs from raw ${row.transaction_hash}:${row.log_index}`);
    }
  }
  return hashes.length;
}

async function assertArchive(rpc, mark) {
  if (BigInt(await rpc.request('eth_chainId')) !== 4663n) {
    throw new Error('Archive chain ID is not Robinhood');
  }
  const block = await rpc.request('eth_getBlockByNumber', [
    `0x${BigInt(mark.checkpoint_block).toString(16)}`, false,
  ]);
  if (!block || BigInt(block.number) !== BigInt(mark.checkpoint_block)
      || block.hash?.toLowerCase() !== mark.checkpoint_hash) {
    throw new Error('Archive checkpoint differs from watermark');
  }
}

function compareDecisions(rows, context) {
  const classifier = classifierFor(context);
  const matches = []; const differences = [];
  for (const row of rows) {
    const decision = classifier.classify(row, context);
    const item = { transactionHash: row.transaction_hash, logIndex: row.log_index,
      storedKind: row.transfer_kind, replayedKind: decision.kind,
      replayReason: decision.reasonCode };
    if (decision.kind === row.transfer_kind
        && decision.classificationVersion === row.classification_version) matches.push(item);
    else differences.push(item);
  }
  return { matches, differences };
}

function makeRpc(deps) {
  const url = String((deps.env || process.env).ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!deps.rpcClient && !url) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  return deps.rpcClient || createEvmJsonRpcClient({
    providers: [{ name: 'archive', url }], timeoutMs: 30_000,
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  parseArgs(argv);
  const database = deps.database || db;
  const mark = await readWatermark(database);
  const population = await readPopulation(database, mark);
  const rows = await readSample(database);
  if (rows.length === 0) throw new Error('pilot decision sample is empty');
  const sampledKinds = new Set(rows.map((row) => row.transfer_kind));
  const missingKinds = population.map((row) => row.transfer_kind)
    .filter((kind) => !sampledKinds.has(kind));
  const rpc = makeRpc(deps);
  await assertArchive(rpc, mark);
  const receiptsMatched = await compareArchiveReceipts(rpc, rows);
  const source = deps.source || createRobinhoodWalletTransferLiveSourceRepository({ database });
  const context = await source.loadBackfillRangeContext(sourceInput(rows));
  if (!context.ready || context.swapCoverageComplete !== true) {
    throw new Error(`historical classification context unavailable: ${context.reason}`);
  }
  const decisions = compareDecisions(rows, context);
  const currentMark = await readWatermark(database);
  if (currentMark.version !== mark.version || currentMark.checkpoint_hash !== mark.checkpoint_hash
      || currentMark.raw_event_count !== mark.raw_event_count) {
    throw new Error('pilot watermark changed during decision audit');
  }
  const report = { mode: 'read-only', day: DAY,
    watermarkVersion: mark.version, checkpointHash: mark.checkpoint_hash,
    population, sampleMethod: `BERNOULLI(${SAMPLE_PERCENT}) REPEATABLE (1907), ${PER_KIND} per kind`,
    sampleRows: rows.length, missingKinds, receiptsMatched,
    decisionMatches: decisions.matches.length, decisionDifferences: decisions.differences,
    archiveReplay: { status: 'sample_only', evidenceReference: null },
    readyForDrop: false, destructive: false };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood transfer pilot decision audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs, sourceInput };
