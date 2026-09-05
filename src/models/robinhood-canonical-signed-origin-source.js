'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const MAX_BLOCKS = 200;

function decimal(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}

function sourceGap(message) {
  return Object.assign(new Error(message), {
    code: 'canonical_signed_origin_source_gap', fatal: true,
  });
}

function normalizeInput(input) {
  const numbers = (input.blockNumbers || []).map((value) => decimal(value, 'blockNumber'));
  if (!numbers.length || numbers.length > MAX_BLOCKS) throw new Error('block batch size is invalid');
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] !== numbers[index - 1] + 1n) throw new Error('blocks must be contiguous');
  }
  const coverageOrigin = decimal(input.coverageOriginBlock, 'coverageOriginBlock');
  const safeHead = decimal(input.safeHead, 'safeHead');
  if (coverageOrigin > numbers[0] || numbers.at(-1) > safeHead) {
    throw new Error('canonical signed-origin range is outside its coverage');
  }
  if (!['seed', 'live'].includes(input.stream)) throw new Error('stream is invalid');
  return { coverageOrigin, numbers, stream: input.stream };
}

function groupRows(rows, numbers) {
  const grouped = new Map();
  for (const row of rows) {
    const number = String(row.block_number);
    if (!grouped.has(number)) grouped.set(number, {
      number, hash: row.block_hash,
      blockTime: new Date(row.block_timestamp).toISOString(), transactions: [],
    });
    if (row.transaction_hash != null) grouped.get(number).transactions.push({
      walletAddress: row.from_address, transactionHash: row.transaction_hash,
      transactionIndex: String(row.transaction_index), nonce: textNonce(row.nonce),
      blockNumber: number, blockHash: row.block_hash,
      blockTime: grouped.get(number).blockTime,
    });
  }
  for (const number of numbers) {
    const block = grouped.get(number.toString());
    if (!block) throw sourceGap(`canonical signed-origin block ${number} is missing`);
    block.transactions.forEach((transaction, index) => {
      if (transaction.transactionIndex !== String(index)) {
        throw sourceGap(`canonical signed-origin block ${number} has a transaction gap`);
      }
    });
  }
  return numbers.map((number) => grouped.get(number.toString()));
}

function createRobinhoodCanonicalSignedOriginSource(options = {}) {
  const database = options.database || db;
  const now = options.now || Date.now;

  async function readBlocks(input = {}) {
    const { coverageOrigin, numbers, stream } = normalizeInput(input);
    const startedAt = now();
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query(
        `SELECT block.block_number, block.block_hash, block.block_timestamp,
                transaction.transaction_hash, transaction.transaction_index,
                transaction.from_address, transaction.nonce
           FROM robinhood_chain_blocks block
           LEFT JOIN robinhood_chain_transactions transaction
             ON transaction.chain=block.chain AND transaction.block_hash=block.block_hash
          WHERE block.chain=$1 AND block.canonical=TRUE
            AND block.block_number BETWEEN $2::bigint AND $3::bigint
          ORDER BY block.block_number, transaction.transaction_index`,
        [CHAIN, numbers[0].toString(), numbers.at(-1).toString()]
      );
      const blocks = groupRows(result.rows, numbers);
      const origins = new Map();
      for (const block of blocks) for (const transaction of block.transactions) {
        if (!origins.has(transaction.walletAddress)) origins.set(transaction.walletAddress, {
          ...transaction, coverageOriginBlock: coverageOrigin.toString(),
          sourceStream: stream, observedAt: new Date(now()).toISOString(),
        });
      }
      await client.query('ROLLBACK');
      const elapsedMs = Math.max(1, now() - startedAt);
      const transactionsScanned = blocks.reduce((sum, block) => sum + block.transactions.length, 0);
      return Object.freeze({
        blocks: Object.freeze(blocks.map((block) => Object.freeze({
          number: block.number, hash: block.hash, blockTime: block.blockTime,
          transactionCount: block.transactions.length,
        }))),
        origins: Object.freeze([...origins.values()].map(Object.freeze)),
        metrics: Object.freeze({
          blocksScanned: blocks.length, transactionsScanned, originsFound: origins.size,
          elapsedMs, blocksPerSecond: Number(((blocks.length * 1000) / elapsedMs).toFixed(2)),
        }),
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ readBlocks });
}

function textNonce(value) {
  if (value == null || !/^\d+$/.test(String(value))) {
    throw sourceGap('canonical signed-origin transaction nonce is missing');
  }
  return String(value);
}

module.exports = { createRobinhoodCanonicalSignedOriginSource };
