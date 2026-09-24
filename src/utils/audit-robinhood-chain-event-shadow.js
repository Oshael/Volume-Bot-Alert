'use strict';

/** Read-only, resumable row parity check for a fixed block range. */
require('dotenv').config();
const db = require('../models/db');

const MAX_BLOCKS = 1000;
const MAX_EVENTS = 5000;
const MAX_PAGES = 10000;
const RELATION = /^(?:public|pg_temp)\.[a-z][a-z0-9_]*$/;

function block(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative safe block number`);
  }
  return parsed;
}

function option(value, name, fallback, maximum) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseArgs(args = []) {
  const values = {};
  for (const arg of args) {
    const match = /^--(from-block|through-block|max-blocks|max-pages)=(\d+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`unknown or repeated argument: ${arg}`);
    values[match[1]] = match[2];
  }
  if (values['from-block'] == null || values['through-block'] == null) {
    throw new Error('--from-block and --through-block are required');
  }
  const fromBlock = block(values['from-block'], 'from-block');
  const throughBlock = block(values['through-block'], 'through-block');
  if (throughBlock < fromBlock) throw new Error('through-block must follow from-block');
  return {
    fromBlock, throughBlock,
    maxBlocks: option(values['max-blocks'], 'max-blocks', 100, MAX_BLOCKS),
    maxPages: option(values['max-pages'], 'max-pages', 1000, MAX_PAGES),
  };
}

function relations(source, shadow) {
  if (!RELATION.test(source) || !RELATION.test(shadow)) {
    throw new Error('audit relations must be qualified identifiers');
  }
  return { source, shadow };
}

async function comparePage(client, fromBlock, pageEnd, input = {}) {
  const { source, shadow } = relations(
    input.source || 'public.robinhood_chain_events',
    input.shadow || 'public.robinhood_chain_events_shadow'
  );
  const bounds = [fromBlock, pageEnd + 1];
  const counts = await client.query(`SELECT
      (SELECT count(*)::bigint FROM ${source} WHERE chain='robinhood'
        AND block_number >= $1::bigint AND block_number < $2::bigint) AS source_events,
      (SELECT count(*)::bigint FROM ${shadow} WHERE chain='robinhood'
        AND block_number >= $1::bigint AND block_number < $2::bigint) AS shadow_events`, bounds);
  const sourceEvents = BigInt(counts.rows[0].source_events);
  const shadowEvents = BigInt(counts.rows[0].shadow_events);
  if (sourceEvents > MAX_EVENTS || shadowEvents > MAX_EVENTS) {
    const error = new Error(`page exceeds ${MAX_EVENTS} events; reduce --max-blocks`);
    error.code = 'shadow_audit_page_too_large';
    throw error;
  }
  if (sourceEvents !== shadowEvents) {
    return { sourceEvents: Number(sourceEvents), shadowEvents: Number(shadowEvents),
      mismatch: 'count' };
  }
  const result = await client.query(`WITH source AS MATERIALIZED (
      SELECT * FROM ${source} WHERE chain='robinhood'
        AND block_number >= $1::bigint AND block_number < $2::bigint
    ), shadow AS MATERIALIZED (
      SELECT * FROM ${shadow} WHERE chain='robinhood'
        AND block_number >= $1::bigint AND block_number < $2::bigint
    ) SELECT COALESCE(event.block_number, copy.block_number) AS block_number,
        COALESCE(event.block_hash, copy.block_hash) AS block_hash,
        COALESCE(event.log_index, copy.log_index) AS log_index
      FROM source event FULL JOIN shadow copy
        ON copy.chain=event.chain AND copy.block_number=event.block_number
       AND copy.block_hash=event.block_hash AND copy.log_index=event.log_index
     WHERE to_jsonb(event) IS DISTINCT FROM to_jsonb(copy)
     LIMIT 1`, bounds);
  return { sourceEvents: Number(sourceEvents), shadowEvents: Number(shadowEvents),
    mismatch: result.rows[0] || null };
}

async function auditPage(database, fromBlock, pageEnd, input = {}) {
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
    const result = await comparePage(client, fromBlock, pageEnd, input);
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
  let pages = 0;
  let events = 0;
  let width = input.maxBlocks;
  let stablePages = 0;
  while (pages < input.maxPages && nextBlock <= input.throughBlock) {
    const pageEnd = Math.min(input.throughBlock, nextBlock + width - 1);
    let result;
    try {
      result = await inspect(database, nextBlock, pageEnd);
    } catch (error) {
      if (error.code !== 'shadow_audit_page_too_large' || width === 1) throw error;
      width = Math.max(1, Math.floor(width / 2));
      stablePages = 0;
      progress({ phase: 'page_reduced', nextBlock, maxBlocks: width });
      continue;
    }
    if (result.mismatch) {
      return { mode: 'read-only', verified: false, pages, events,
        nextBlock, mismatch: result.mismatch,
        sourceEvents: result.sourceEvents, shadowEvents: result.shadowEvents };
    }
    pages += 1;
    events += result.sourceEvents;
    nextBlock = pageEnd + 1;
    progress({ phase: 'page', page: pages, throughBlock: pageEnd, events: result.sourceEvents });
    stablePages += 1;
    if (stablePages >= 16 && width < input.maxBlocks) {
      width = Math.min(input.maxBlocks, width * 2);
      stablePages = 0;
    }
  }
  const complete = nextBlock > input.throughBlock;
  return { mode: 'read-only', verified: complete, pages, events,
    nextBlock: complete ? null : nextBlock,
    stopReason: complete ? 'complete' : 'page_limit' };
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
  console.error('Robinhood chain event shadow audit failed:', error.message);
  process.exitCode = 1;
});

module.exports = { auditRange, comparePage, parseArgs };
