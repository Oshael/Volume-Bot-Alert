'use strict';

/** Stage 238 - freeze a durable terminal key for the wallet-swap state backfill. */
const db = require('../models/db');
const { SOURCE_TABLE } = require('./db-init-stage236');
const { PROGRESS_TABLE } = require('./db-init-stage237');

const TARGET_CONSTRAINT = 'rh_wallet_swap_realtime_state_backfill_target_check';
const STATEMENTS = Object.freeze([
  `ALTER TABLE ${PROGRESS_TABLE}
     ADD COLUMN IF NOT EXISTS target_transaction_hash VARCHAR(66),
     ADD COLUMN IF NOT EXISTS target_log_index BIGINT,
     ADD COLUMN IF NOT EXISTS target_block_hash VARCHAR(66),
     ADD COLUMN IF NOT EXISTS target_event_kind VARCHAR(16),
     ADD COLUMN IF NOT EXISTS target_captured_at TIMESTAMPTZ`,
  `ALTER TABLE ${PROGRESS_TABLE}
     DROP CONSTRAINT IF EXISTS ${TARGET_CONSTRAINT},
     ADD CONSTRAINT ${TARGET_CONSTRAINT} CHECK (
       (target_transaction_hash IS NULL AND target_log_index IS NULL
        AND target_block_hash IS NULL AND target_event_kind IS NULL
        AND target_captured_at IS NULL)
       OR (target_transaction_hash ~ '^0x[0-9a-f]{64}$' AND target_log_index >= 0
        AND target_log_index IS NOT NULL AND target_block_hash IS NOT NULL
        AND target_event_kind IS NOT NULL AND target_captured_at IS NOT NULL
        AND target_block_hash ~ '^0x[0-9a-f]{64}$'
        AND target_event_kind IN ('observed','finalized','invalidate'))
     )`,
  `WITH target AS MATERIALIZED (
     SELECT transaction_hash, log_index, block_hash, event_kind
       FROM ${SOURCE_TABLE} WHERE chain='robinhood'
      ORDER BY transaction_hash DESC, log_index DESC, block_hash DESC, event_kind DESC
      LIMIT 1
   )
   UPDATE ${PROGRESS_TABLE} progress SET
     target_transaction_hash=target.transaction_hash,
     target_log_index=target.log_index,
     target_block_hash=target.block_hash,
     target_event_kind=target.event_kind,
     target_captured_at=NOW(), updated_at=NOW()
   FROM target
   WHERE progress.chain='robinhood' AND progress.completed_at IS NULL
     AND progress.target_transaction_hash IS NULL`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
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
  console.log('Stage 238 wallet-swap state backfill target frozen successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 238:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, TARGET_CONSTRAINT, init };
