'use strict';

/** Read-only, resumable parity audit for a fixed finalized block range. */
require('dotenv').config();
const db = require('../models/db');
const { sourcePage } = require('./copy-robinhood-chain-transaction-shadow-page');

const MAX_BLOCKS = 100;
const MAX_TRANSACTIONS = 5000;
const MAX_PAGES = 1000;

function nonnegativeBlock(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a nonnegative safe block number`);
  }
  return parsed;
}

function boundedOption(value, label, fallback, maximum) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseArgs(args = []) {
  const values = {};
  for (const arg of args) {
    const match = /^--(from-block|through-block|max-blocks|max-pages)=(\d+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`invalid argument: ${arg}`);
    values[match[1]] = match[2];
  }
  const fromBlock = nonnegativeBlock(values['from-block'], 'fromBlock');
  const throughBlock = nonnegativeBlock(values['through-block'], 'throughBlock');
  if (throughBlock < fromBlock) throw new Error('throughBlock must follow fromBlock');
  return { fromBlock, throughBlock,
    maxBlocks: boundedOption(values['max-blocks'], 'maxBlocks', 10, MAX_BLOCKS),
    maxPages: boundedOption(values['max-pages'], 'maxPages', 100, MAX_PAGES) };
}

async function comparePage(client, fromBlock, pageEnd) {
  const bounds = [fromBlock, pageEnd + 1];
  const source = (await sourcePage(client, fromBlock, pageEnd)).rows[0];
  const shadow = await client.query(`SELECT count(*)::bigint AS transactions
    FROM public.robinhood_chain_transactions_shadow
    WHERE chain='robinhood' AND block_number >= $1::bigint
      AND block_number < $2::bigint`, bounds);
  const sourceTransactions = BigInt(source.transactions);
  const shadowTransactions = BigInt(shadow.rows[0].transactions);
  if (sourceTransactions > MAX_TRANSACTIONS || shadowTransactions > MAX_TRANSACTIONS) {
    const error = new Error(`page exceeds ${MAX_TRANSACTIONS} transactions; reduce --max-blocks`);
    error.code = 'transaction_shadow_audit_page_too_large';
    throw error;
  }
  const counts = { sourceTransactions: Number(sourceTransactions),
    shadowTransactions: Number(shadowTransactions) };
  if (sourceTransactions !== shadowTransactions) return { ...counts, mismatch: 'count' };
  const mismatch = await client.query(`WITH scoped_blocks AS MATERIALIZED (
      SELECT chain, block_number, block_hash
        FROM public.robinhood_chain_blocks
       WHERE chain='robinhood' AND block_number >= $1::bigint
         AND block_number < $2::bigint
    ), source AS MATERIALIZED (
      SELECT tx.*, block.block_number
        FROM scoped_blocks block
        JOIN LATERAL (
          SELECT item.* FROM public.robinhood_chain_transactions item
           WHERE item.chain=block.chain AND item.block_hash=block.block_hash
           OFFSET 0
        ) tx ON TRUE
    ), shadow AS MATERIALIZED (
      SELECT * FROM public.robinhood_chain_transactions_shadow
       WHERE chain='robinhood' AND block_number >= $1::bigint
         AND block_number < $2::bigint
    ) SELECT COALESCE(original.block_number, copy.block_number) AS block_number,
        COALESCE(original.block_hash, copy.block_hash) AS block_hash,
        COALESCE(original.transaction_hash, copy.transaction_hash) AS transaction_hash,
        CASE WHEN original.transaction_hash IS NULL THEN 'extra_shadow'
             WHEN copy.transaction_hash IS NULL THEN 'missing_shadow'
             ELSE 'payload' END AS reason
      FROM source original FULL JOIN shadow copy
        ON copy.chain=original.chain AND copy.block_number=original.block_number
       AND copy.block_hash=original.block_hash
       AND copy.transaction_hash=original.transaction_hash
     WHERE to_jsonb(original) IS DISTINCT FROM to_jsonb(copy)
     LIMIT 1`, bounds);
  return { ...counts, mismatch: mismatch.rows[0] || null };
}

async function auditPage(database, fromBlock, pageEnd) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const cursor = await client.query(`SELECT finalized_head, recovery_state
      FROM public.robinhood_chain_capture_cursor WHERE chain='robinhood'`);
    if (cursor.rows[0]?.recovery_state !== 'running'
        || cursor.rows[0]?.finalized_head == null
        || BigInt(cursor.rows[0].finalized_head) < BigInt(pageEnd)) {
      throw new Error('capture is not running or page is above finalized head');
    }
    const result = await comparePage(client, fromBlock, pageEnd);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function auditRange(input, deps = {}) {
  const database = deps.database || db;
  const inspect = deps.inspect || auditPage;
  const progress = deps.progress || (() => {});
  let nextBlock = input.fromBlock;
  let width = input.maxBlocks;
  let pages = 0;
  let transactions = 0;
  while (pages < input.maxPages && nextBlock <= input.throughBlock) {
    const pageEnd = Math.min(input.throughBlock, nextBlock + width - 1);
    let result;
    try {
      result = await inspect(database, nextBlock, pageEnd);
    } catch (error) {
      if (error.code !== 'transaction_shadow_audit_page_too_large' || width === 1) throw error;
      width = Math.max(1, Math.floor(width / 2));
      progress({ phase: 'page_reduced', nextBlock, maxBlocks: width });
      continue;
    }
    if (result.mismatch) {
      return { mode: 'read-only', verified: false, stopReason: 'mismatch',
        fromBlock: input.fromBlock, throughBlock: input.throughBlock,
        nextBlock, pages, transactions, ...result };
    }
    pages += 1;
    transactions += result.sourceTransactions;
    nextBlock = pageEnd + 1;
    progress({ phase: 'page', page: pages, throughBlock: pageEnd,
      transactions: result.sourceTransactions });
  }
  const complete = nextBlock > input.throughBlock;
  return { mode: 'read-only', verified: complete,
    stopReason: complete ? 'complete' : 'page_limit',
    fromBlock: input.fromBlock, throughBlock: input.throughBlock,
    nextBlock: complete ? null : nextBlock, pages, transactions };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  try {
    const result = await auditRange(options, {
      progress: (entry) => console.log(JSON.stringify(entry)),
    });
    console.log(JSON.stringify({ phase: 'summary', ...result }));
    if (!result.verified) process.exitCode = 2;
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood chain transaction shadow audit failed:', error.message);
  process.exitCode = 1;
});

module.exports = { auditPage, auditRange, comparePage, parseArgs };
