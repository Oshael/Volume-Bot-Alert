'use strict';

const db = require('../models/db');

const CHAIN = 'robinhood';
const EXPECTED_CHAIN_ID = '4663';
const MAX_BLOCKS = 100;
const MAX_COVERAGE_BLOCKS = 50_000n;

function uint(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized);
}

function address(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function sourceGap(message, detail = {}) {
  return Object.assign(new Error(message), {
    code: 'canonical_bundle_funding_source_gap', fatal: true, ...detail,
  });
}

function timestampSeconds(value) {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw sourceGap('canonical block timestamp is invalid');
  return BigInt(Math.floor(milliseconds / 1000)).toString();
}

function normalizeNumbers(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_BLOCKS) {
    throw new Error('canonical bundle-funding block batch size is invalid');
  }
  const numbers = input.map((value) => uint(value, 'blockNumber'));
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] !== numbers[index - 1] + 1n) {
      throw new Error('canonical bundle-funding blocks must be contiguous');
    }
  }
  return numbers;
}

function groupRows(rows, numbers) {
  const grouped = new Map();
  for (const row of rows) {
    const blockNumber = String(row.block_number);
    if (!grouped.has(blockNumber)) grouped.set(blockNumber, {
      blockNumber, blockHash: row.block_hash,
      blockTimestamp: timestampSeconds(row.block_timestamp), transactions: [],
    });
    if (row.transaction_hash == null) continue;
    if (row.value_wei == null) {
      throw sourceGap(`canonical bundle-funding transaction value is missing at ${blockNumber}`);
    }
    grouped.get(blockNumber).transactions.push({
      transactionHash: row.transaction_hash,
      transactionIndex: String(row.transaction_index),
      fromAddress: row.from_address, toAddress: row.to_address,
      valueWei: String(row.value_wei), blockNumber,
      blockHash: row.block_hash,
      blockTimestamp: grouped.get(blockNumber).blockTimestamp,
    });
  }
  return numbers.map((number) => {
    const block = grouped.get(number.toString());
    if (!block) throw sourceGap(`canonical bundle-funding block ${number} is missing`);
    block.transactions.forEach((transaction, index) => {
      if (transaction.transactionIndex !== String(index)) {
        throw sourceGap(`canonical bundle-funding block ${number} has a transaction gap`);
      }
    });
    return block;
  });
}

function createRobinhoodCanonicalBundleFundingReader(options = {}) {
  const database = options.database || db;
  const candidateWallets = new Set((options.candidateWallets || []).map((value) => (
    address(value, 'candidateWallet')
  )));

  async function assertChain() {
    const result = await database.query(
      'SELECT 1 FROM robinhood_chain_capture_cursor WHERE chain=$1', [CHAIN]
    );
    if (!result.rowCount) throw sourceGap('canonical capture cursor is missing');
    return EXPECTED_CHAIN_ID;
  }

  async function checkpoint(blockNumber) {
    const number = uint(blockNumber, 'blockNumber').toString();
    const result = await database.query(
      `SELECT block_hash FROM robinhood_chain_blocks
        WHERE chain=$1 AND canonical=TRUE AND block_number=$2::bigint`,
      [CHAIN, number]
    );
    if (!result.rows[0]) {
      throw sourceGap(`canonical bundle-funding checkpoint ${number} is missing`);
    }
    return result.rows[0].block_hash;
  }

  async function readBlocks(blockNumbers) {
    const numbers = normalizeNumbers(blockNumbers);
    const result = await database.query(
      `SELECT block.block_number, block.block_hash, block.block_timestamp,
              transaction.transaction_hash, transaction.transaction_index,
              transaction.from_address, transaction.to_address, transaction.value_wei
         FROM robinhood_chain_blocks block
         LEFT JOIN robinhood_chain_transactions transaction
           ON transaction.chain=block.chain AND transaction.block_hash=block.block_hash
        WHERE block.chain=$1 AND block.canonical=TRUE
          AND block.block_number BETWEEN $2::bigint AND $3::bigint
        ORDER BY block.block_number, transaction.transaction_index`,
      [CHAIN, numbers[0].toString(), numbers.at(-1).toString()]
    );
    const blocks = groupRows(result.rows, numbers);
    const transfers = blocks.flatMap((block) => block.transactions.filter((transaction) => (
      BigInt(transaction.valueWei) > 0n && transaction.toAddress != null
    )));
    return Object.freeze({
      blocksScanned: blocks.length,
      payloadBytes: Buffer.byteLength(JSON.stringify(result.rows)),
      transfers: Object.freeze(transfers.map(Object.freeze)),
      candidateInboundTransfers: transfers.filter(({ toAddress }) => (
        candidateWallets.has(toAddress)
      )).length,
      candidateOutboundTransfers: transfers.filter(({ fromAddress }) => (
        candidateWallets.has(fromAddress)
      )).length,
    });
  }

  async function assertCoverage(input = {}) {
    const from = uint(input.fromBlock, 'fromBlock');
    const through = uint(input.throughBlock, 'throughBlock');
    if (from > through || through - from + 1n > MAX_COVERAGE_BLOCKS) {
      throw new Error('canonical bundle-funding coverage range is invalid');
    }
    const result = await database.query(
      `WITH coverage AS MATERIALIZED (
         SELECT block.block_number,
                COUNT(transaction.transaction_hash) AS transaction_count,
                COALESCE(MAX(transaction.transaction_index), -1) + 1 AS indexed_count,
                COUNT(transaction.transaction_hash) FILTER (
                  WHERE transaction.value_wei IS NULL
                ) AS missing_values
           FROM robinhood_chain_blocks block
           LEFT JOIN robinhood_chain_transactions transaction
             ON transaction.chain=block.chain AND transaction.block_hash=block.block_hash
          WHERE block.chain=$1 AND block.canonical=TRUE
            AND block.block_number BETWEEN $2::bigint AND $3::bigint
          GROUP BY block.block_number
       ) SELECT COUNT(*) AS blocks,
                COUNT(*) FILTER (WHERE transaction_count<>indexed_count) AS transaction_gaps,
                COALESCE(SUM(missing_values), 0) AS missing_values,
                (SELECT MIN(block_number) FROM robinhood_chain_blocks
                  WHERE chain=$1 AND canonical=TRUE) AS journal_start_block
           FROM coverage`,
      [CHAIN, from.toString(), through.toString()]
    );
    const row = result.rows[0] || {};
    const journalStart = row.journal_start_block == null
      ? null : BigInt(row.journal_start_block);
    if (journalStart != null && from < journalStart) {
      throw sourceGap(`canonical bundle-funding range starts before journal at ${journalStart}`, {
        reason: 'before_journal', requestedFromBlock: from.toString(),
        journalStartBlock: journalStart.toString(),
      });
    }
    if (BigInt(row.blocks || 0) !== through - from + 1n) {
      throw sourceGap(`canonical bundle-funding coverage has missing blocks after ${from}`);
    }
    if (Number(row.transaction_gaps || 0) > 0) {
      throw sourceGap(`canonical bundle-funding coverage has transaction gaps after ${from}`);
    }
    if (BigInt(row.missing_values || 0) > 0n) {
      throw sourceGap(`canonical bundle-funding coverage has missing values after ${from}`);
    }
    return true;
  }

  return Object.freeze({ assertChain, assertCoverage, checkpoint, readBlocks });
}

module.exports = {
  createRobinhoodCanonicalBundleFundingReader,
  __private: { address, groupRows, normalizeNumbers, timestampSeconds },
};
