'use strict';

/** Stage 225 - narrow Robinhood head-state claim indexes. */
const db = require('../models/db');

const INDEX_NAMES = Object.freeze([
  'idx_rh_head_capture_states_v4_active_frontier',
  'idx_rh_head_capture_states_market_independent_claim',
  'idx_rh_head_capture_states_discovery_claim',
]);

const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[0]}
     ON robinhood_head_capture_states (
       market_key, block_number, transaction_index, log_index
     ) INCLUDE (transaction_hash, processing_status, next_attempt_at)
     WHERE chain = 'robinhood'
       AND stream = 'market'
       AND protocol = 'uniswap-v4'
       AND market_key IS NOT NULL
       AND processing_status IN ('pending', 'leased', 'blocked')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[1]}
     ON robinhood_head_capture_states (
       block_number, transaction_index, log_index, next_attempt_at
     ) INCLUDE (transaction_hash)
     WHERE chain = 'robinhood'
       AND stream = 'market'
       AND protocol IS DISTINCT FROM 'uniswap-v4'
       AND processing_status = 'pending'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[2]}
     ON robinhood_head_capture_states (
       block_number, transaction_index, log_index, next_attempt_at
     ) INCLUDE (transaction_hash)
     WHERE chain = 'robinhood'
       AND stream = 'discovery'
       AND processing_status = 'pending'`,
]);

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
  if (missing.length) throw new Error(`Stage 225 indexes are not ready: ${missing.join(', ')}`);
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (let index = 0; index < INDEX_NAMES.length; index += 1) {
      await removeInvalidIndex(database, INDEX_NAMES[index]);
      await database.query(STATEMENTS[index]);
    }
    await assertIndexesReady(database);
    console.log('Stage 225 Robinhood head-state claim indexes created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 225:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAMES, STATEMENTS, assertIndexesReady, init, removeInvalidIndex };
