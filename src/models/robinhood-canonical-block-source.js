'use strict';

const db = require('./db');

const CHAIN = 'robinhood';

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function timestampTag(value) {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('canonical block timestamp is invalid');
  return blockTag(BigInt(Math.floor(milliseconds / 1000)));
}

function buildBlock(rows) {
  const first = rows?.[0];
  if (!first) return null;
  return {
    number: blockTag(first.block_number),
    hash: first.block_hash,
    timestamp: timestampTag(first.block_timestamp),
    transactions: rows.filter((row) => row.transaction_hash != null).map((row) => ({
      hash: row.transaction_hash,
      from: row.from_address,
      transactionIndex: blockTag(row.transaction_index),
    })),
  };
}

function createRobinhoodCanonicalBlockSource(options = {}) {
  const database = options.database || db;

  async function loadBlock(blockNumber) {
    const result = await database.query(
      `SELECT block.block_number, block.block_hash, block.block_timestamp,
              transaction.transaction_hash, transaction.transaction_index,
              transaction.from_address
         FROM robinhood_chain_blocks block
         LEFT JOIN robinhood_chain_transactions transaction
           ON transaction.chain=block.chain AND transaction.block_hash=block.block_hash
        WHERE block.chain=$1 AND block.canonical=TRUE AND block.block_number=$2::bigint
        ORDER BY transaction.transaction_index`,
      [CHAIN, BigInt(blockNumber).toString()]
    );
    return buildBlock(result.rows);
  }

  return Object.freeze({ loadBlock });
}

module.exports = {
  createRobinhoodCanonicalBlockSource,
  __private: { blockTag, buildBlock, timestampTag },
};
