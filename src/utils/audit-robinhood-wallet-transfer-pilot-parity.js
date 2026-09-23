'use strict';

require('dotenv').config();

const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { TRANSFER_TOPIC } = require('../services/evm-erc20-supply-delta');

const PILOT_DAYS = new Set(['2026-07-18', '2026-07-19']);
const CHAIN = 'robinhood';
const VERSION = 'rh_transfer_v1';
const SAMPLE_SIZE = 24;
const HASH = /^0x[0-9a-f]{64}$/;

function quantity(value, label) {
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(String(value ?? ''))) {
    throw new Error(`${label} is invalid`);
  }
  return BigInt(value).toString();
}

function addressTopic(value) {
  const topic = String(value ?? '').toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(topic)) throw new Error('receipt address topic is invalid');
  return `0x${topic.slice(-40)}`;
}

function receiptMatches(raw, receipt) {
  return Boolean(receipt && receipt.transactionHash?.toLowerCase() === raw.transaction_hash
    && receipt.blockHash?.toLowerCase() === raw.block_hash
    && quantity(receipt.blockNumber, 'receipt.blockNumber') === raw.block_number
    && quantity(receipt.transactionIndex, 'receipt.transactionIndex')
      === String(raw.transaction_index)
    && Array.isArray(receipt.logs));
}

function logMatches(raw, log) {
  return Boolean(log && log.removed !== true && log.address?.toLowerCase() === raw.token_address
    && log.blockHash?.toLowerCase() === raw.block_hash
    && log.transactionHash?.toLowerCase() === raw.transaction_hash
    && log.topics?.length === 3 && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
    && addressTopic(log.topics[1]) === raw.from_wallet
    && addressTopic(log.topics[2]) === raw.to_wallet
    && quantity(log.data, 'receipt.amount') === raw.amount_raw);
}

function compareReceipt(raw, receipt) {
  if (!receiptMatches(raw, receipt)) return false;
  const log = receipt.logs.find((item) => (
    quantity(item.logIndex, 'receipt.logIndex') === String(raw.log_index)
  ));
  return logMatches(raw, log);
}

function parseArgs(argv) {
  const day = argv.length === 1 && argv[0]?.startsWith('--day=')
    ? argv[0].slice('--day='.length) : null;
  if (!PILOT_DAYS.has(day)) {
    throw new Error('read-only pilot audit requires --day=2026-07-18 or --day=2026-07-19');
  }
  return { day, partition: `public.robinhood_token_transfer_events_${day.replace(/-/g, '_')}` };
}

function archiveClient(deps) {
  const rpcUrl = String((deps.env || process.env).ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!deps.rpcClient && !rpcUrl) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  return deps.rpcClient || createEvmJsonRpcClient({
    providers: [{ name: 'archive', url: rpcUrl }], timeoutMs: 30_000,
  });
}

async function verifiedWatermark(database, day) {
  const watermark = (await database.query(
    `SELECT version::text, checkpoint_block::text, checkpoint_hash,
            raw_event_count::text, eligible_transfer_count::text,
            eligible_amount_raw::text, summary_transfer_count::text,
            summary_amount_raw::text, lifecycle_state
       FROM robinhood_wallet_transfer_compaction_watermarks
      WHERE chain=$1 AND projection_version=$2 AND partition_day=$3::date`,
    [CHAIN, VERSION, day]
  )).rows[0];
  if (!watermark || watermark.lifecycle_state !== 'verified'
      || !HASH.test(watermark.checkpoint_hash || '')) {
    throw new Error('pilot watermark is missing or no longer verified');
  }
  return watermark;
}

async function assertArchiveCheckpoint(rpc, watermark) {
  const checkpoint = await rpc.request('eth_getBlockByNumber', [
    `0x${BigInt(watermark.checkpoint_block).toString(16)}`, false,
  ]);
  if (quantity(checkpoint?.number, 'archive.checkpoint.number') !== watermark.checkpoint_block
      || checkpoint?.hash?.toLowerCase() !== watermark.checkpoint_hash) {
    throw new Error('Archive checkpoint differs from the verified watermark');
  }
}

async function verifiedTotals(database, watermark, partition) {
  const totals = (await database.query(
    `SELECT COUNT(*)::text AS raw_event_count,
            COUNT(*) FILTER (WHERE classification_version=$1
              AND transfer_kind IN ('wallet_transfer', 'dex_flow'))::text
              AS eligible_transfer_count,
            COALESCE(SUM(amount_raw) FILTER (WHERE classification_version=$1
              AND transfer_kind IN ('wallet_transfer', 'dex_flow')), 0)::text
              AS eligible_amount_raw
       FROM ${partition} WHERE chain=$2`, [VERSION, CHAIN]
  )).rows[0];
  for (const key of ['raw_event_count', 'eligible_transfer_count', 'eligible_amount_raw']) {
    if (totals?.[key] !== watermark[key]) {
      throw new Error(`pilot raw ${key} differs from watermark`);
    }
  }
  if (watermark.summary_transfer_count !== watermark.eligible_transfer_count
      || watermark.summary_amount_raw !== watermark.eligible_amount_raw) {
    throw new Error('pilot summary totals differ from watermark');
  }
  return totals;
}

async function compareSample(database, rpc, partition) {
  const { rows: sample } = await database.query(
    `SELECT transaction_hash, log_index, block_number::text, block_hash,
            transaction_index, token_address, from_wallet, to_wallet,
            amount_raw::text, transfer_kind, classification_version
       FROM ${partition} WHERE chain=$1
      ORDER BY transaction_hash, log_index, block_time
      LIMIT $2::integer`, [CHAIN, SAMPLE_SIZE]
  );
  if (sample.length !== SAMPLE_SIZE) throw new Error('pilot raw sample is incomplete');
  const receipts = new Map();
  for (const row of sample) {
    if (!receipts.has(row.transaction_hash)) {
      receipts.set(row.transaction_hash,
        await rpc.request('eth_getTransactionReceipt', [row.transaction_hash]));
    }
    if (!compareReceipt(row, receipts.get(row.transaction_hash))) {
      throw new Error(`Archive receipt differs from raw event ${row.transaction_hash}:${row.log_index}`);
    }
  }
  return { requested: SAMPLE_SIZE, matched: sample.length, distinctTransactions: receipts.size,
    selection: 'first 24 by transaction_hash, log_index, block_time',
    first: `${sample[0].transaction_hash}:${sample[0].log_index}`,
    last: `${sample.at(-1).transaction_hash}:${sample.at(-1).log_index}` };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const { day, partition } = parseArgs(argv);
  const database = deps.database || db;
  const rpc = archiveClient(deps);
  const chainId = quantity(await rpc.request('eth_chainId'), 'archive.chainId');
  if (chainId !== '4663') throw new Error('Archive chain ID is not Robinhood');
  const watermark = await verifiedWatermark(database, day);
  await assertArchiveCheckpoint(rpc, watermark);
  const totals = await verifiedTotals(database, watermark, partition);
  const deterministicReceiptSample = await compareSample(database, rpc, partition);
  const report = { mode: 'read-only', day, watermarkVersion: watermark.version,
    checkpointBlock: watermark.checkpoint_block, checkpointHash: watermark.checkpoint_hash,
    chainId, totals, deterministicReceiptSample,
    archiveReplay: { status: 'sample_only', evidenceReference: null },
    readyForDrop: false, destructive: false };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood transfer pilot parity audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { compareReceipt, main, parseArgs };
