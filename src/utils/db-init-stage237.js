'use strict';

/** Stage 237 - resumable backfill cursor for the wallet-swap realtime state shadow. */
const db = require('../models/db');

const PROGRESS_TABLE = 'robinhood_wallet_swap_realtime_state_backfills';
const VALUES_CONSTRAINT = 'rh_wallet_swap_realtime_state_backfill_values_check';
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${PROGRESS_TABLE} (
     chain VARCHAR(16) PRIMARY KEY DEFAULT 'robinhood',
     pass BIGINT NOT NULL DEFAULT 1,
     after_transaction_hash VARCHAR(66),
     after_log_index BIGINT,
     after_block_hash VARCHAR(66),
     after_event_kind VARCHAR(16),
     scanned BIGINT NOT NULL DEFAULT 0,
     inserted BIGINT NOT NULL DEFAULT 0,
     completed_at TIMESTAMPTZ,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE ${PROGRESS_TABLE}
     DROP CONSTRAINT IF EXISTS ${VALUES_CONSTRAINT},
     ADD CONSTRAINT ${VALUES_CONSTRAINT} CHECK (
       chain='robinhood' AND pass > 0 AND scanned >= 0 AND inserted >= 0
       AND ((after_transaction_hash IS NULL AND after_log_index IS NULL
             AND after_block_hash IS NULL AND after_event_kind IS NULL)
         OR (after_transaction_hash ~ '^0x[0-9a-f]{64}$' AND after_log_index >= 0
             AND after_log_index IS NOT NULL AND after_block_hash IS NOT NULL
             AND after_event_kind IS NOT NULL
             AND after_block_hash ~ '^0x[0-9a-f]{64}$'
             AND after_event_kind IN ('observed','finalized','invalidate')))
     )`,
  `INSERT INTO ${PROGRESS_TABLE} (chain) VALUES ('robinhood')
   ON CONFLICT (chain) DO NOTHING`,
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
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then(() => {
  console.log('Stage 237 Robinhood wallet-swap realtime state backfill created successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 237:', error.message);
  process.exitCode = 1;
});

module.exports = { PROGRESS_TABLE, STATEMENTS, VALUES_CONSTRAINT, init };
