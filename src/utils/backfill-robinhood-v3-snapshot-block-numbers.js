'use strict';

/** One bounded page of the Stage 247 V3 snapshot block-number backfill. */
const db = require('../models/db');

function decodeCursor(value) {
  if (!value) return { chain: '', blockHash: '', logIndex: -1 };
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid cursor');
  }
  if (cursor.chain !== 'robinhood' || !/^0x[0-9a-f]{64}$/.test(cursor.blockHash)
      || !Number.isSafeInteger(cursor.logIndex) || cursor.logIndex < 0) {
    throw new Error('invalid cursor');
  }
  return cursor;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ chain: row.chain, blockHash: row.block_hash,
    logIndex: row.log_index })).toString('base64url');
}

function validateRows(rows) {
  for (const row of rows) {
    if (row.event_block === null || (row.stored_block !== null
        && row.stored_block !== row.event_block)) {
      throw new Error(`V3 snapshot/event mismatch at ${row.block_hash}:${row.log_index}`);
    }
  }
  return rows.filter((row) => row.stored_block === null);
}

async function applyPage(client, cursor, rows, missingCount) {
  if (!missingCount) return;
  const updated = await client.query(`UPDATE public.robinhood_chain_v3_balance_snapshots snapshot
    SET block_number = event.block_number
    FROM public.robinhood_chain_events event
    WHERE snapshot.chain = event.chain
      AND snapshot.block_hash = event.block_hash
      AND snapshot.log_index = event.log_index
      AND snapshot.block_number IS NULL
      AND (snapshot.chain, snapshot.block_hash, snapshot.log_index)
        > ($1::text, $2::text, $3::integer)
      AND (snapshot.chain, snapshot.block_hash, snapshot.log_index)
        <= ($4::text, $5::text, $6::integer)`,
  [cursor.chain, cursor.blockHash, cursor.logIndex,
    rows.at(-1).chain, rows.at(-1).block_hash, rows.at(-1).log_index]);
  if (updated.rowCount !== missingCount) {
    throw new Error('V3 snapshot batch changed during backfill');
  }
}

async function run(options = {}) {
  const database = options.database || db;
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error('batchSize must be between 1 and 5000');
  }
  const cursor = decodeCursor(options.cursor);
  let client;
  try {
    client = await database.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const { rows } = await client.query(`SELECT snapshot.chain, snapshot.block_hash,
        snapshot.log_index, snapshot.block_number AS stored_block,
        event.block_number AS event_block
      FROM public.robinhood_chain_v3_balance_snapshots snapshot
      LEFT JOIN public.robinhood_chain_events event
        USING (chain, block_hash, log_index)
      WHERE (snapshot.chain, snapshot.block_hash, snapshot.log_index)
        > ($1::text, $2::text, $3::integer)
      ORDER BY snapshot.chain, snapshot.block_hash, snapshot.log_index
      LIMIT $4 FOR UPDATE OF snapshot`,
    [cursor.chain, cursor.blockHash, cursor.logIndex, batchSize]);
    const missing = validateRows(rows);
    if (options.apply) await applyPage(client, cursor, rows, missing.length);
    const result = { mode: options.apply ? 'apply' : 'read-only', scanned: rows.length,
      filled: options.apply ? missing.length : 0,
      remainingInPage: options.apply ? 0 : missing.length,
      nextCursor: rows.length ? encodeCursor(rows.at(-1)) : null,
      scanComplete: rows.length < batchSize };
    await client.query(options.apply ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

function cliOptions(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--batch-size=')) options.batchSize = Number(arg.slice(13));
    else if (arg.startsWith('--cursor=')) options.cursor = arg.slice(9);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (require.main === module) run(cliOptions(process.argv.slice(2))).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error('V3 snapshot block-number backfill failed:', error.message);
  process.exitCode = 1;
});

module.exports = { cliOptions, decodeCursor, encodeCursor, run };
