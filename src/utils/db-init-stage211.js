'use strict';

/** Stage 211 - indexed terminalization state for the Stage 204 lifecycle. */
const db = require('../models/db');

const TABLE = 'robinhood_wallet_swap_realtime_outbox';
const INDEX_NAME = 'idx_rh_wallet_swap_realtime_outbox_unterminalized';
const LEGACY_INDEX_NAME = 'idx_rh_wallet_swap_realtime_outbox_promote';
const STATEMENTS = Object.freeze([
  `ALTER TABLE ${TABLE}
     ADD COLUMN IF NOT EXISTS terminalized_at TIMESTAMPTZ`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
     ON ${TABLE}(block_number, transaction_index, log_index)
     WHERE chain='robinhood' AND event_kind='observed' AND terminalized_at IS NULL`,
  `DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_INDEX_NAME}`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const invalid = await database.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)`,
      [INDEX_NAME]
    );
    if (invalid.rows[0]?.indisvalid === false) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
    }
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 211 Robinhood trade lifecycle terminalization applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 211:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAME, LEGACY_INDEX_NAME, STATEMENTS, TABLE, init };
