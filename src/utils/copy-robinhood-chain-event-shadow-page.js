'use strict';

/** Copy one bounded historical block page; the live capture remains authoritative. */
require('dotenv').config();
const db = require('../models/db');
const { mirrorCapturedEvents } = require('../models/robinhood-chain-event-shadow');

const MAX_BLOCKS = 1000;
const MAX_EVENTS = 5000;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

function positiveBlock(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a nonnegative safe block number`);
  }
  return number;
}

function normalizeOptions(input = {}) {
  const fromBlock = positiveBlock(input.fromBlock, 'fromBlock');
  const throughBlock = positiveBlock(input.throughBlock, 'throughBlock');
  const maxBlocks = input.maxBlocks == null ? 100 : Number(input.maxBlocks);
  if (throughBlock < fromBlock) throw new Error('throughBlock must follow fromBlock');
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_BLOCKS) {
    throw new Error(`maxBlocks must be between 1 and ${MAX_BLOCKS}`);
  }
  const pageEnd = Math.min(throughBlock, fromBlock + maxBlocks - 1);
  return { fromBlock, throughBlock, pageEnd, apply: input.apply === true };
}

function parseArgs(args = []) {
  const values = {};
  for (const arg of args) {
    if (arg === '--apply' && values.apply == null) { values.apply = true; continue; }
    const match = /^--(from-block|through-block|max-blocks)=(\d+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`unknown or repeated argument: ${arg}`);
    values[match[1]] = match[2];
  }
  if (values['from-block'] == null || values['through-block'] == null) {
    throw new Error('--from-block and --through-block are required');
  }
  return normalizeOptions({ fromBlock: values['from-block'],
    throughBlock: values['through-block'], maxBlocks: values['max-blocks'],
    apply: values.apply });
}

async function assertFinalizedPage(client, pageEnd) {
  const cursor = await client.query(`SELECT finalized_head, recovery_state
    FROM public.robinhood_chain_capture_cursor WHERE chain='robinhood'`);
  if (cursor.rows[0]?.recovery_state !== 'running'
      || cursor.rows[0]?.finalized_head == null
      || BigInt(cursor.rows[0].finalized_head) < BigInt(pageEnd)) {
    throw new Error('capture is not running or page is above finalized head');
  }
}

function assertBoundedSource({ events, source_bytes: sourceBytes }) {
  if (BigInt(events) > BigInt(MAX_EVENTS) || BigInt(sourceBytes) > BigInt(MAX_SOURCE_BYTES)) {
    throw new Error(`page exceeds ${MAX_EVENTS} events or ${MAX_SOURCE_BYTES} source bytes; reduce --max-blocks`);
  }
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
        hashtext('robinhood-chain-event-shadow-copy')) AS locked`);
      if (!lock.rows[0]?.locked) throw new Error('another shadow copy is running');
    }
    await assertFinalizedPage(client, options.pageEnd);
    const source = await client.query(`SELECT count(*)::bigint AS events,
        COALESCE(sum(pg_column_size(event)), 0)::bigint AS source_bytes,
        COALESCE(array_agg(DISTINCT event.block_hash), ARRAY[]::varchar[]) AS hashes
      FROM public.robinhood_chain_events event
      WHERE event.chain='robinhood'
        AND event.block_number >= $1::bigint AND event.block_number < $2::bigint`,
    [options.fromBlock, options.pageEnd + 1]);
    const { events, source_bytes: sourceBytes, hashes } = source.rows[0];
    assertBoundedSource(source.rows[0]);
    let inserted = 0;
    if (options.apply && hashes.length) {
      inserted = (await mirrorCapturedEvents(client,
        hashes.map((block_hash) => ({ block_hash })))).inserted;
    }
    await client.query('COMMIT');
    return { mode: options.apply ? 'apply' : 'read-only',
      fromBlock: options.fromBlock, pageEnd: options.pageEnd,
      nextBlock: options.pageEnd < options.throughBlock ? options.pageEnd + 1 : null,
      events, sourceBytes, hashes: hashes.length, inserted };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main(args = process.argv.slice(2)) {
  try {
    const result = await copyPage(parseArgs(args));
    console.log(JSON.stringify(result));
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood chain event shadow copy failed:', error.message);
  process.exitCode = 1;
});

module.exports = { MAX_BLOCKS, MAX_EVENTS, MAX_SOURCE_BYTES,
  assertBoundedSource, copyPage, normalizeOptions, parseArgs };
