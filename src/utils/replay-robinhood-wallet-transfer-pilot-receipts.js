'use strict';

require('dotenv').config();

const { createHash } = require('node:crypto');
const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { compareReceipt } = require('./audit-robinhood-wallet-transfer-pilot-parity');

const DAY = '2026-07-19';
const PARTITION = 'public.robinhood_token_transfer_events_2026_07_19';
const VERSION = 'rh_transfer_v1';
const START_DIGEST = '0'.repeat(64);
const HASH = /^0x[0-9a-f]{64}$/;

function positiveInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return number;
}

function parseArgs(argv) {
  const input = { batchSize: 1000, maxBatches: 10, after: null };
  const seen = new Set();
  for (const arg of argv) {
    const match = arg.match(/^--(day|batch-size|max-batches|after)=(.+)$/);
    if (!match || seen.has(match[1])) throw new Error(`invalid or duplicate argument: ${arg}`);
    seen.add(match[1]);
    if (match[1] === 'day' && match[2] === DAY) continue;
    if (match[1] === 'batch-size') input.batchSize = positiveInteger(match[2], 'batch-size', 5000);
    else if (match[1] === 'max-batches') {
      input.maxBatches = positiveInteger(match[2], 'max-batches', 100);
    } else if (match[1] === 'after') input.after = match[2];
    else throw new Error(`pilot replay requires --day=${DAY}`);
  }
  if (!seen.has('day')) throw new Error(`pilot replay requires --day=${DAY}`);
  return input;
}

function decodeCursor(encoded) {
  if (!encoded) return null;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) throw new Error('invalid replay cursor');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch (_) {
    throw new Error('invalid replay cursor');
  }
  if (cursor.day !== DAY || !/^\d+$/.test(cursor.watermarkVersion || '')
      || !HASH.test(cursor.checkpointHash || '')
      || !/^0x[0-9a-f]{64}$/.test(cursor.transactionHash || '')
      || !Number.isSafeInteger(cursor.logIndex) || cursor.logIndex < 0
      || !Number.isFinite(Date.parse(cursor.blockTime))
      || !Number.isSafeInteger(cursor.scanned) || cursor.scanned < 1
      || !/^[0-9a-f]{64}$/.test(cursor.digest || '')) {
    throw new Error('invalid replay cursor');
  }
  return cursor;
}

async function watermark(database) {
  const row = (await database.query(
    `SELECT version::text, checkpoint_block::text, checkpoint_hash,
            raw_event_count::text, lifecycle_state
       FROM robinhood_wallet_transfer_compaction_watermarks
      WHERE chain='robinhood' AND projection_version=$1 AND partition_day=$2::date`,
    [VERSION, DAY]
  )).rows[0];
  if (!row || row.lifecycle_state !== 'verified' || !HASH.test(row.checkpoint_hash || '')
      || !/^\d+$/.test(row.raw_event_count || '')) {
    throw new Error('verified pilot watermark is unavailable');
  }
  return row;
}

function assertCursor(cursor, mark) {
  if (cursor && (cursor.watermarkVersion !== mark.version
      || cursor.checkpointHash !== mark.checkpoint_hash
      || BigInt(cursor.scanned) >= BigInt(mark.raw_event_count))) {
    throw new Error('replay cursor does not match the current watermark');
  }
}

async function assertArchive(rpc, mark) {
  const chainId = await rpc.request('eth_chainId');
  if (BigInt(chainId || 0) !== 4663n) throw new Error('Archive chain ID is not Robinhood');
  const block = await rpc.request('eth_getBlockByNumber', [
    `0x${BigInt(mark.checkpoint_block).toString(16)}`, false,
  ]);
  if (!block || BigInt(block.number || 0) !== BigInt(mark.checkpoint_block)
      || block.hash?.toLowerCase() !== mark.checkpoint_hash) {
    throw new Error('Archive checkpoint differs from the verified watermark');
  }
}

async function readBatch(database, cursor, limit) {
  return (await database.query(
    `SELECT transaction_hash, log_index, block_time, block_number::text,
            block_hash, transaction_index, token_address, from_wallet,
            to_wallet, amount_raw::text, transfer_kind, classification_version
       FROM ${PARTITION}
      WHERE chain='robinhood' AND ($1::text IS NULL OR
        (transaction_hash, log_index, block_time) >
        ($1::text, $2::integer, $3::timestamptz))
      ORDER BY transaction_hash, log_index, block_time LIMIT $4::integer`,
    [cursor?.transactionHash || null, cursor?.logIndex || null,
      cursor?.blockTime || null, limit + 1]
  )).rows;
}

async function checkReceipts(rpc, rows) {
  const receipts = new Map();
  const hashes = [...new Set(rows.map((row) => row.transaction_hash))];
  for (let start = 0; start < hashes.length; start += 100) {
    const slice = hashes.slice(start, start + 100);
    const values = await rpc.requestBatch(slice.map((hash) => ({
      method: 'eth_getTransactionReceipt', params: [hash],
    })));
    if (!Array.isArray(values) || values.length !== slice.length) {
      throw new Error('Archive receipt batch is incomplete');
    }
    slice.forEach((hash, index) => receipts.set(hash, values[index]));
  }
  for (const row of rows) {
    if (!compareReceipt(row, receipts.get(row.transaction_hash))) {
      throw new Error(`Archive receipt differs from raw ${row.transaction_hash}:${row.log_index}`);
    }
  }
  return hashes.length;
}

function advance(cursor, rows, mark) {
  let digest = cursor?.digest || START_DIGEST;
  for (const row of rows) {
    const fields = [row.transaction_hash, row.log_index,
      new Date(row.block_time).toISOString(), row.block_number, row.block_hash,
      row.transaction_index, row.token_address, row.from_wallet, row.to_wallet,
      row.amount_raw, row.transfer_kind, row.classification_version];
    digest = createHash('sha256').update(digest).update(JSON.stringify(fields)).digest('hex');
  }
  const last = rows.at(-1);
  return { day: DAY, watermarkVersion: mark.version,
    checkpointHash: mark.checkpoint_hash, transactionHash: last.transaction_hash,
    logIndex: last.log_index, blockTime: new Date(last.block_time).toISOString(),
    scanned: (cursor?.scanned || 0) + rows.length, digest };
}

function archiveClient(deps) {
  const url = String((deps.env || process.env).ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!deps.rpcClient && !url) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  return deps.rpcClient || createEvmJsonRpcClient({
    providers: [{ name: 'archive', url }], timeoutMs: 30_000,
  });
}

async function scanBatches(database, rpc, input, mark, initialCursor, logger) {
  let cursor = initialCursor;
  let scanComplete = false;
  let scannedThisRun = 0;
  let receiptsThisRun = 0;
  for (let batch = 1; batch <= input.maxBatches; batch += 1) {
    const fetched = await readBatch(database, cursor, input.batchSize);
    const rows = fetched.slice(0, input.batchSize);
    if (rows.length) {
      const receipts = await checkReceipts(rpc, rows);
      cursor = advance(cursor, rows, mark);
      scannedThisRun += rows.length;
      receiptsThisRun += receipts;
      logger.log(JSON.stringify({ batch, scanned: cursor.scanned,
        receipts, nextCursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') }));
    }
    if (fetched.length <= input.batchSize) { scanComplete = true; break; }
  }
  return { cursor, scanComplete, scannedThisRun, receiptsThisRun };
}

function reportFor(mark, scan, resumed) {
  const { cursor, scanComplete, scannedThisRun, receiptsThisRun } = scan;
  if (scanComplete && String(cursor?.scanned || 0) !== mark.raw_event_count) {
    throw new Error('complete replay count differs from watermark');
  }
  return { mode: 'read-only', day: DAY,
    watermarkVersion: mark.version, checkpointHash: mark.checkpoint_hash,
    scannedThisRun, receiptsThisRun, scannedTotal: cursor?.scanned || 0,
    expectedRawEvents: mark.raw_event_count, digest: cursor?.digest || START_DIGEST,
    nextCursor: scanComplete ? null : Buffer.from(JSON.stringify(cursor)).toString('base64url'),
    scanComplete, archiveRawReceipts: scanComplete && !resumed
      ? 'matched_in_one_run' : scanComplete ? 'resume_requires_log_verification' : 'partial',
    archiveReplay: { status: 'partial', evidenceReference: null },
    readyForDrop: false, destructive: false };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const input = parseArgs(argv);
  const database = deps.database || db;
  const mark = await watermark(database);
  const cursor = decodeCursor(input.after);
  assertCursor(cursor, mark);
  const rpc = archiveClient(deps);
  await assertArchive(rpc, mark);
  const scan = await scanBatches(database, rpc, input, mark, cursor, deps.logger || console);
  await assertArchive(rpc, mark);
  const currentMark = await watermark(database);
  if (currentMark.version !== mark.version || currentMark.checkpoint_hash !== mark.checkpoint_hash
      || currentMark.raw_event_count !== mark.raw_event_count) {
    throw new Error('pilot watermark changed during replay');
  }
  const report = reportFor(mark, scan, Boolean(cursor));
  (deps.logger || console).log(JSON.stringify(report));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood transfer receipt replay failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { advance, decodeCursor, main, parseArgs };
