'use strict';

/** Fill only V3 snapshots whose events exist in the verified shadow range. */
const db = require('../models/db');

const MAX_BATCH_SIZE = 5000;

function block(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative safe block number`);
  }
  return parsed;
}

function options(input = {}) {
  const fromBlock = block(input.fromBlock, 'from-block');
  const throughBlock = block(input.throughBlock, 'through-block');
  const batchSize = input.batchSize == null ? 1000 : Number(input.batchSize);
  if (throughBlock < fromBlock) throw new Error('through-block must follow from-block');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batch-size must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  let cursor = { blockNumber: fromBlock - 1, blockHash: '', logIndex: -1 };
  if (input.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new Error('invalid cursor');
    }
    if (cursor.fromBlock !== fromBlock || cursor.throughBlock !== throughBlock
        || !Number.isSafeInteger(cursor.blockNumber)
        || cursor.blockNumber < fromBlock || cursor.blockNumber > throughBlock
        || !/^0x[0-9a-f]{64}$/.test(cursor.blockHash)
        || !Number.isSafeInteger(cursor.logIndex) || cursor.logIndex < 0) {
      throw new Error('cursor does not match the requested range');
    }
  }
  return { fromBlock, throughBlock, batchSize, cursor, apply: input.apply === true };
}

function encodeCursor(input, row) {
  return Buffer.from(JSON.stringify({ fromBlock: input.fromBlock,
    throughBlock: input.throughBlock, blockNumber: Number(row.event_block),
    blockHash: row.block_hash, logIndex: row.log_index })).toString('base64url');
}

function validateRows(rows) {
  for (const row of rows) {
    if (row.stored_block !== null && row.stored_block !== row.event_block) {
      throw new Error(`V3 snapshot/shadow mismatch at ${row.block_hash}:${row.log_index}`);
    }
  }
  return rows.filter((row) => row.stored_block === null);
}

async function run(input = {}) {
  const config = options(input);
  const database = input.database || db;
  const client = await database.getClient();
  try {
    await client.query(config.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const selected = await client.query(`SELECT event.block_number::text AS event_block,
        event.block_hash, event.log_index, snapshot.block_number::text AS stored_block
      FROM public.robinhood_chain_events_shadow event
      JOIN public.robinhood_chain_v3_balance_snapshots snapshot
        ON snapshot.chain=event.chain AND snapshot.block_hash=event.block_hash
       AND snapshot.log_index=event.log_index
     WHERE event.chain='robinhood'
       AND event.block_number BETWEEN $1::bigint AND $2::bigint
       AND (event.block_number, event.block_hash, event.log_index)
         > ($3::bigint, $4::varchar, $5::integer)
     ORDER BY event.block_number, event.block_hash, event.log_index
     LIMIT $6 ${config.apply ? 'FOR UPDATE OF snapshot' : ''}`,
    [config.fromBlock, config.throughBlock, config.cursor.blockNumber,
      config.cursor.blockHash, config.cursor.logIndex, config.batchSize]);
    const missing = validateRows(selected.rows);
    let filled = 0;
    if (config.apply && missing.length) {
      const updated = await client.query(`WITH requested AS (
          SELECT item.block_hash, item.log_index, item.block_number
            FROM jsonb_to_recordset($1::jsonb) AS item(
              block_hash text, log_index integer, block_number bigint)
        ), changed AS (
          UPDATE public.robinhood_chain_v3_balance_snapshots snapshot
             SET block_number=requested.block_number
            FROM requested
           WHERE snapshot.chain='robinhood'
             AND snapshot.block_hash=requested.block_hash
             AND snapshot.log_index=requested.log_index
             AND snapshot.block_number IS NULL
          RETURNING 1
        ) SELECT count(*)::integer AS filled FROM changed`,
      [JSON.stringify(missing.map((row) => ({ block_hash: row.block_hash,
        log_index: row.log_index, block_number: row.event_block })))]);
      filled = updated.rows[0].filled;
      if (filled !== missing.length) throw new Error('V3 snapshot page changed during backfill');
    }
    const scanComplete = selected.rows.length < config.batchSize;
    const result = { mode: config.apply ? 'apply' : 'read-only',
      fromBlock: config.fromBlock, throughBlock: config.throughBlock,
      scanned: selected.rows.length, missing: missing.length, filled,
      nextCursor: scanComplete ? null : encodeCursor(config, selected.rows.at(-1)),
      scanComplete };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (input.closePool !== false) await database.pool.end().catch(() => {});
  }
}

function parseArgs(args = []) {
  const values = {};
  for (const arg of args) {
    if (arg === '--apply' && values.apply == null) { values.apply = true; continue; }
    const match = /^--(from-block|through-block|batch-size|cursor)=(.+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`unknown or repeated argument: ${arg}`);
    values[match[1]] = match[2];
  }
  if (values['from-block'] == null || values['through-block'] == null) {
    throw new Error('--from-block and --through-block are required');
  }
  return { fromBlock: values['from-block'], throughBlock: values['through-block'],
    batchSize: values['batch-size'], cursor: values.cursor, apply: values.apply };
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error('Robinhood V3 shadow snapshot backfill failed:', error.message);
  process.exitCode = 1;
});

module.exports = { options, parseArgs, run, validateRows };
