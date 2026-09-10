'use strict';

/** Stage 205 - durable Robinhood canonical-capture recovery fence. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_chain_capture_cursor
     ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS recovery_state VARCHAR(24) NOT NULL DEFAULT 'running',
     ADD COLUMN IF NOT EXISTS recovery_plan JSONB,
     ADD COLUMN IF NOT EXISTS recovery_detected_at TIMESTAMPTZ`,
  `ALTER TABLE robinhood_chain_capture_cursor
     DROP CONSTRAINT IF EXISTS rh_chain_capture_cursor_recovery_check`,
  `ALTER TABLE robinhood_chain_capture_cursor
     ADD CONSTRAINT rh_chain_capture_cursor_recovery_check CHECK (
       generation >= 0
       AND recovery_state IN ('running', 'recovery_required')
       AND (
         (recovery_state = 'running'
           AND recovery_plan IS NULL AND recovery_detected_at IS NULL)
         OR
         (recovery_state = 'recovery_required'
           AND jsonb_typeof(recovery_plan) = 'object'
           AND recovery_detected_at IS NOT NULL)
       )
     )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 205 Robinhood capture recovery fence created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 205:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
