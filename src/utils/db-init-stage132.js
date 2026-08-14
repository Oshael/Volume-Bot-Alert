/** Stage 132 - fail-closed daily compaction watermarks for Robinhood transfers. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_compaction_watermarks (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL,
     partition_day DATE NOT NULL,
     lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'pending',
     state_reason VARCHAR(500),
     raw_event_count BIGINT NOT NULL DEFAULT 0,
     target_classified_event_count BIGINT NOT NULL DEFAULT 0,
     eligible_transfer_count BIGINT NOT NULL DEFAULT 0,
     eligible_amount_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
     summary_transfer_count BIGINT NOT NULL DEFAULT 0,
     summary_amount_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
     raw_last_block BIGINT,
     raw_last_transaction_index INTEGER,
     raw_last_log_index INTEGER,
     cursor_next_block BIGINT,
     cursor_next_transaction_index INTEGER,
     cursor_next_log_index INTEGER,
     cursor_next_block_time TIMESTAMPTZ,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     position_projection_version VARCHAR(64),
     position_next_block BIGINT,
     summary_reconciled BOOLEAN NOT NULL DEFAULT false,
     position_complete BOOLEAN NOT NULL DEFAULT false,
     evidence_complete BOOLEAN NOT NULL DEFAULT false,
     cursor_complete BOOLEAN NOT NULL DEFAULT false,
     checkpoint_canonical BOOLEAN NOT NULL DEFAULT false,
     audited_at TIMESTAMPTZ,
     verified_at TIMESTAMPTZ,
     dropped_at TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_compaction_pkey PRIMARY KEY (
       chain, projection_version, partition_day
     ),
     CONSTRAINT rh_wallet_transfer_compaction_chain_check CHECK (
       chain = 'robinhood'
     ),
     CONSTRAINT rh_wallet_transfer_compaction_version_check CHECK (
       projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND (position_projection_version IS NULL OR
         position_projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
       AND version >= 0
     ),
     CONSTRAINT rh_wallet_transfer_compaction_values_check CHECK (
       raw_event_count >= 0
       AND target_classified_event_count BETWEEN 0 AND raw_event_count
       AND eligible_transfer_count BETWEEN 0 AND target_classified_event_count
       AND eligible_amount_raw >= 0
       AND summary_transfer_count >= 0
       AND summary_amount_raw >= 0
     ),
     CONSTRAINT rh_wallet_transfer_compaction_positions_check CHECK (
       ((raw_last_block IS NULL AND raw_last_transaction_index IS NULL AND raw_last_log_index IS NULL)
         OR (raw_last_block >= 0 AND raw_last_transaction_index >= 0 AND raw_last_log_index >= 0))
       AND ((cursor_next_block IS NULL AND cursor_next_transaction_index IS NULL
           AND cursor_next_log_index IS NULL AND cursor_next_block_time IS NULL)
         OR (cursor_next_block >= 0 AND cursor_next_transaction_index >= 0
           AND cursor_next_log_index >= 0 AND cursor_next_block_time IS NOT NULL))
       AND ((checkpoint_block IS NULL) = (checkpoint_hash IS NULL))
       AND (checkpoint_block IS NULL OR (
         checkpoint_block >= 0 AND checkpoint_hash ~ '^0x[0-9a-f]{64}$'
         AND cursor_next_block IS NOT NULL AND checkpoint_block <= cursor_next_block
       ))
       AND ((position_projection_version IS NULL) = (position_next_block IS NULL))
       AND (position_next_block IS NULL OR position_next_block >= 0)
       AND ((raw_event_count = 0) = (raw_last_block IS NULL))
     ),
     CONSTRAINT rh_wallet_transfer_compaction_reconciliation_check CHECK (
       lifecycle_state NOT IN ('verified', 'dropped') OR (
         target_classified_event_count = raw_event_count
         AND summary_transfer_count = eligible_transfer_count
         AND summary_amount_raw = eligible_amount_raw
         AND summary_reconciled AND position_complete AND evidence_complete AND cursor_complete
         AND checkpoint_canonical
         AND cursor_next_block_time >=
           ((partition_day + 1)::timestamp AT TIME ZONE 'UTC')
         AND checkpoint_block IS NOT NULL
         AND position_projection_version IS NOT NULL
         AND (raw_event_count = 0 OR (
           (cursor_next_block, cursor_next_transaction_index, cursor_next_log_index) >
             (raw_last_block, raw_last_transaction_index, raw_last_log_index)
           AND position_next_block > raw_last_block
         ))
       )
     ),
     CONSTRAINT rh_wallet_transfer_compaction_lifecycle_check CHECK (
       lifecycle_state IN ('pending', 'blocked', 'verified', 'dropped')
       AND (
         (lifecycle_state = 'pending' AND state_reason IS NULL
           AND audited_at IS NULL AND verified_at IS NULL AND dropped_at IS NULL)
         OR (lifecycle_state = 'blocked' AND NULLIF(BTRIM(state_reason), '') IS NOT NULL
           AND audited_at IS NOT NULL AND verified_at IS NULL AND dropped_at IS NULL)
         OR (lifecycle_state = 'verified' AND state_reason IS NULL
           AND audited_at IS NOT NULL AND verified_at IS NOT NULL AND dropped_at IS NULL)
         OR (lifecycle_state = 'dropped' AND state_reason IS NULL
           AND audited_at IS NOT NULL AND verified_at IS NOT NULL
           AND dropped_at IS NOT NULL AND dropped_at >= verified_at)
       )
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_compaction_state
     ON robinhood_wallet_transfer_compaction_watermarks(
       chain, lifecycle_state, partition_day, projection_version
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 132 Robinhood transfer compaction watermarks created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 132:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
