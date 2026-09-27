'use strict';

/** Copy one finalized block page. The live capture remains authoritative. */
require('dotenv').config();
const db = require('../models/db');
const { mirrorCapturedTransactions } = require('../models/robinhood-chain-transaction-shadow');

const MAX_BLOCKS = 100;
const MAX_TRANSACTIONS = 5000;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

function block(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a nonnegative safe block number`);
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  const fromBlock = block(input.fromBlock, 'fromBlock');
  const throughBlock = block(input.throughBlock, 'throughBlock');
  const maxBlocks = input.maxBlocks == null ? 10 : Number(input.maxBlocks);
  if (throughBlock < fromBlock) throw new Error('throughBlock must follow fromBlock');
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_BLOCKS) {
    throw new Error(`maxBlocks must be between 1 and ${MAX_BLOCKS}`);
  }
  return { fromBlock, throughBlock, maxBlocks,
    pageEnd: Math.min(throughBlock, fromBlock + maxBlocks - 1),
    apply: input.apply === true };
}

function parseArgs(args = []) {
  const values = {};
  for (const arg of args) {
    if (arg === '--apply' && values.apply == null) { values.apply = true; continue; }
    const match = /^--(from-block|through-block|max-blocks)=(\d+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`invalid argument: ${arg}`);
    values[match[1]] = match[2];
  }
  if (values['from-block'] == null || values['through-block'] == null) {
    throw new Error('--from-block and --through-block are required');
  }
  return normalizeOptions({ fromBlock: values['from-block'],
    throughBlock: values['through-block'], maxBlocks: values['max-blocks'],
    apply: values.apply });
}

function assertBoundedSource({ transactions, source_bytes: sourceBytes }) {
  if (BigInt(transactions) > BigInt(MAX_TRANSACTIONS)
      || BigInt(sourceBytes) > BigInt(MAX_SOURCE_BYTES)) {
    const error = new Error(
      `page exceeds ${MAX_TRANSACTIONS} transactions or ${MAX_SOURCE_BYTES} source bytes; reduce --max-blocks`
    );
    error.code = 'transaction_shadow_copy_page_too_large';
    throw error;
  }
}

async function assertFinalizedPage(client, pageEnd) {
  const result = await client.query(`SELECT finalized_head, recovery_state
    FROM public.robinhood_chain_capture_cursor WHERE chain='robinhood'`);
  if (result.rows[0]?.recovery_state !== 'running'
      || result.rows[0]?.finalized_head == null
      || BigInt(result.rows[0].finalized_head) < BigInt(pageEnd)) {
    throw new Error('capture is not running or page is above finalized head');
  }
}

async function sourcePage(client, fromBlock, pageEnd) {
  return client.query(`WITH scoped_blocks AS MATERIALIZED (
      SELECT chain, block_hash
        FROM public.robinhood_chain_blocks
       WHERE chain='robinhood' AND block_number >= $1::bigint
         AND block_number < $2::bigint
    ) SELECT count(tx.block_hash)::bigint AS transactions,
        COALESCE(sum(tx.source_bytes), 0)::bigint AS source_bytes,
        COALESCE(array_agg(DISTINCT tx.block_hash)
          FILTER (WHERE tx.block_hash IS NOT NULL), ARRAY[]::varchar[]) AS hashes
      FROM scoped_blocks block
      LEFT JOIN LATERAL (
        SELECT item.block_hash, pg_column_size(item)::integer AS source_bytes
          FROM public.robinhood_chain_transactions item
         WHERE item.chain=block.chain AND item.block_hash=block.block_hash
         OFFSET 0
      ) tx ON TRUE`, [fromBlock, pageEnd + 1]);
}

async function copyPage(input, deps = {}) {
  const options = normalizeOptions(input);
  const database = deps.database || db;
  const client = await database.getClient();
  try {
    await client.query(options.apply
      ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
      : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    if (options.apply) {
      const lock = await client.query(`SELECT pg_try_advisory_xact_lock(
        hashtext('robinhood-chain-transaction-shadow-copy')) AS locked`);
      if (!lock.rows[0]?.locked) throw new Error('another transaction shadow copy is running');
    }
    await assertFinalizedPage(client, options.pageEnd);
    const { rows: [source] } = await sourcePage(client, options.fromBlock, options.pageEnd);
    assertBoundedSource(source);
    let inserted = 0;
    if (options.apply && source.hashes.length) {
      inserted = (await mirrorCapturedTransactions(client,
        source.hashes.map((block_hash) => ({ block_hash })))).inserted;
    }
    await client.query('COMMIT');
    return { mode: options.apply ? 'apply' : 'read-only',
      fromBlock: options.fromBlock, pageEnd: options.pageEnd,
      nextBlock: options.pageEnd < options.throughBlock ? options.pageEnd + 1 : null,
      transactions: source.transactions, sourceBytes: source.source_bytes,
      hashes: source.hashes.length, inserted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main(args = process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(await copyPage(parseArgs(args))));
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood chain transaction shadow copy failed:', error.message);
  process.exitCode = 1;
});

module.exports = { MAX_BLOCKS, MAX_TRANSACTIONS, MAX_SOURCE_BYTES,
  assertBoundedSource, copyPage, normalizeOptions, parseArgs, sourcePage };
