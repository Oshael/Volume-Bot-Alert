'use strict';

/** Stage 221 - bounded economic wallet-swap frontier lookup. */
const db = require('../models/db');

const INDEX_NAME = 'idx_rh_wallet_swap_outbox_active_frontier';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_wallet_swap_outbox(block_number)
  WHERE chain='robinhood' AND status IN ('pending', 'leased', 'blocked')`;

async function init(options = {}) {
  const database = options.database || db;
  try {
    const current = await database.query(
      'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
      [INDEX_NAME]
    );
    if (current.rows[0] && (!current.rows[0].indisvalid || !current.rows[0].indisready)) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
    }
    await database.query(CREATE_STATEMENT);
    const ready = await database.query(
      'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
      [INDEX_NAME]
    );
    if (!ready.rows[0]?.indisvalid || !ready.rows[0]?.indisready) {
      throw new Error(`Stage 221 index is not ready: ${INDEX_NAME}`);
    }
    console.log('Stage 221 Robinhood wallet-swap frontier index created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 221:', error.message);
  process.exitCode = 1;
});

module.exports = { CREATE_STATEMENT, INDEX_NAME, init };
