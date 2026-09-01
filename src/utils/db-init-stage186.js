'use strict';

/** Stage 186 - bounded Robinhood market processing claims. */
const db = require('../models/db');

const V4_FRONTIER_INDEX = 'idx_rh_head_captures_v4_active_frontier';
const INDEPENDENT_CLAIM_INDEX = 'idx_rh_head_captures_market_independent_claim';
const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${V4_FRONTIER_INDEX}
     ON robinhood_head_captures (
       market_key, block_number, transaction_index, log_index
     ) INCLUDE (transaction_hash)
     WHERE chain = 'robinhood'
       AND stream = 'market'
       AND protocol = 'uniswap-v4'
       AND processing_status IN ('pending', 'leased', 'blocked')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEPENDENT_CLAIM_INDEX}
     ON robinhood_head_captures (
       block_number, transaction_index, log_index, next_attempt_at
     ) INCLUDE (transaction_hash)
     WHERE chain = 'robinhood'
       AND stream = 'market'
       AND protocol IS DISTINCT FROM 'uniswap-v4'
       AND processing_status = 'pending'`,
]);
const INDEX_NAMES = Object.freeze([V4_FRONTIER_INDEX, INDEPENDENT_CLAIM_INDEX]);

async function removeInvalidIndex(database, indexName) {
  const result = await database.query(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [indexName]
  );
  if (result.rows[0]?.indisvalid !== false) return;
  await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
}

async function assertIndexesReady(database) {
  const result = await database.query(
    `SELECT indexrelid::regclass::text AS index_name, indisvalid, indisready
       FROM pg_index WHERE indexrelid = ANY($1::regclass[])`,
    [INDEX_NAMES]
  );
  const ready = new Set(result.rows
    .filter((row) => row.indisvalid && row.indisready)
    .map((row) => row.index_name));
  const missing = INDEX_NAMES.filter((indexName) => !ready.has(indexName));
  if (missing.length) throw new Error(`Stage 186 indexes are not ready: ${missing.join(', ')}`);
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (let index = 0; index < INDEX_NAMES.length; index += 1) {
      await removeInvalidIndex(database, INDEX_NAMES[index]);
      await database.query(STATEMENTS[index]);
    }
    await assertIndexesReady(database);
    console.log('Stage 186 Robinhood market claim indexes created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 186:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAMES, STATEMENTS, assertIndexesReady, init, removeInvalidIndex };
