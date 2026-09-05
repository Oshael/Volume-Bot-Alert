'use strict';

const db = require('./db');

const CHAIN = 'robinhood';

function sourceError(message) {
  return Object.assign(new Error(message), { code: 'source_contract_error', fatal: true });
}

function blockTime(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw sourceError('canonical block timestamp is invalid');
  return parsed.toISOString();
}

function blockNumbers(captured) {
  const numbers = new Set([String(captured.fromBlock), String(captured.toBlock)]);
  for (const transfer of captured.transfers) numbers.add(String(transfer.blockNumber));
  return [...numbers];
}

function createRobinhoodCanonicalWalletTransferSource(options = {}) {
  const database = options.database || db;
  const transferReader = options.transferReader;
  if (typeof transferReader?.readGlobalRange !== 'function'
      || typeof transferReader?.matchesCheckpoint !== 'function') {
    throw new TypeError('canonical Transfer reader is required');
  }

  async function readRange(input = {}) {
    const captured = await transferReader.readGlobalRange(input);
    const numbers = blockNumbers(captured);
    const result = await database.query(
      `SELECT block_number, block_hash, block_timestamp
         FROM robinhood_chain_blocks
        WHERE chain=$1 AND canonical=TRUE AND block_number=ANY($2::bigint[])`,
      [CHAIN, numbers]
    );
    const blocks = new Map(result.rows.map((row) => [String(row.block_number), {
      hash: row.block_hash, blockTime: blockTime(row.block_timestamp),
    }]));
    const missing = numbers.find((number) => !blocks.has(number));
    if (missing) throw sourceError(`canonical wallet-transfer block ${missing} is missing`);
    const checkpoint = blocks.get(String(captured.toBlock));
    if (checkpoint.hash !== captured.checkpoint.hash) {
      throw sourceError('canonical wallet-transfer checkpoint changed during read');
    }
    const transfers = captured.transfers.map((transfer) => {
      const block = blocks.get(String(transfer.blockNumber));
      if (block.hash !== transfer.blockHash) {
        throw sourceError('canonical wallet-transfer event conflicts with its block');
      }
      return Object.freeze({ ...transfer, blockTime: block.blockTime });
    });
    return Object.freeze({
      ...captured,
      fromBlockTime: blocks.get(String(captured.fromBlock)).blockTime,
      checkpoint: Object.freeze({ ...captured.checkpoint, blockTime: checkpoint.blockTime }),
      transfers: Object.freeze(transfers),
      telemetry: Object.freeze({
        ...(captured.telemetry || {}), source: 'canonical-journal',
        evidenceBlocks: numbers.length, evidenceBatches: 1,
      }),
    });
  }

  return Object.freeze({
    matchesCheckpoint: (checkpoint) => transferReader.matchesCheckpoint(checkpoint),
    readRange,
  });
}

module.exports = {
  createRobinhoodCanonicalWalletTransferSource,
  __private: { blockNumbers, blockTime },
};
