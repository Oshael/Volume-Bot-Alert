'use strict';

/** Stage 229 - durable bounded-scan cursor for Robinhood holder journal pruning. */
const db = require('../models/db');

const TABLE_NAME = 'robinhood_holder_journal_prune_scans';
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
     chain VARCHAR(16) PRIMARY KEY DEFAULT 'robinhood',
     scan_cutoff_block BIGINT,
     cursor_block_number BIGINT,
     cursor_transaction_index INTEGER,
     cursor_log_index INTEGER,
     cursor_transaction_hash VARCHAR(66),
     completed_passes BIGINT NOT NULL DEFAULT 0,
     last_pass_completed_at TIMESTAMPTZ,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_journal_prune_scans_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_journal_prune_scans_cursor_check CHECK (
       completed_passes >= 0
       AND (scan_cutoff_block IS NULL OR scan_cutoff_block >= 0)
       AND num_nonnulls(
         cursor_block_number, cursor_transaction_index,
         cursor_log_index, cursor_transaction_hash
       ) IN (0, 4)
       AND (cursor_block_number IS NULL OR (
         scan_cutoff_block IS NOT NULL
         AND cursor_block_number >= 0
         AND cursor_block_number < scan_cutoff_block
         AND cursor_transaction_index >= 0
         AND cursor_log_index >= 0
         AND cursor_transaction_hash ~ '^0x[0-9a-f]{64}$'
       ))
     )
   )`,
  `INSERT INTO ${TABLE_NAME} (chain)
   VALUES ('robinhood') ON CONFLICT (chain) DO NOTHING`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      for (const statement of STATEMENTS) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
    console.log('Stage 229 Robinhood holder journal prune scan cursor created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 229:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, TABLE_NAME, init };
