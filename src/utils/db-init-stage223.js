'use strict';

/** Stage 223 - ordered rejected-market queue for targeted capture repairs. */
const db = require('../models/db');

const INDEX_NAME = 'idx_rh_head_captures_rejected_market_repair';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_head_captures(
    block_number, transaction_index, log_index, transaction_hash
  ) INCLUDE (protocol, market_key)
  WHERE chain='robinhood' AND stream='market' AND processing_status='rejected'`;
const STATEMENTS = Object.freeze([CREATE_STATEMENT]);

async function inspect(database) {
  const result = await database.query(
    `SELECT indisvalid, indisready
       FROM pg_index WHERE indexrelid=to_regclass($1)`,
    [INDEX_NAME]
  );
  return result.rows[0] || null;
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    const current = await inspect(database);
    if (current && (!current.indisvalid || !current.indisready)) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
    }
    await database.query(CREATE_STATEMENT);
    const ready = await inspect(database);
    if (!ready?.indisvalid || !ready?.indisready) {
      throw new Error(`Stage 223 index is not ready: ${INDEX_NAME}`);
    }
    console.log('Stage 223 Robinhood rejected-market repair index created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 223:', error.message);
  process.exitCode = 1;
});

module.exports = { CREATE_STATEMENT, INDEX_NAME, STATEMENTS, init, inspect };
