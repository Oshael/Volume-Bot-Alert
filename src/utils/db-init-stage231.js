'use strict';
/** Stage 231 - durable per-token start of Robinhood holder live-tail coverage. */
const db = require('../models/db');
const CONSTRAINT_NAME = 'rh_holder_token_states_tail_coverage_check';
const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_token_states
     ADD COLUMN IF NOT EXISTS tail_capture_from_block BIGINT`,
  `ALTER TABLE robinhood_holder_token_states
     DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME},
     ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (
       tail_capture_from_block IS NULL OR (
         deployment_block IS NOT NULL
         AND backfill_next_block IS NOT NULL
         AND tail_capture_from_block >= deployment_block
         AND backfill_next_block >= deployment_block
         AND (live_through_block IS NULL OR live_through_block >= deployment_block)
         AND (
           ledger_status NOT IN ('shadow', 'live') OR (
             backfill_next_block >= tail_capture_from_block
             AND live_through_block >= tail_capture_from_block - 1
           )
         )
       )
     ) NOT VALID`,
  `ALTER TABLE robinhood_holder_token_states
     VALIDATE CONSTRAINT ${CONSTRAINT_NAME}`,
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
    console.log('Stage 231 Robinhood holder tail coverage created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}
if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 231:', error.message);
  process.exitCode = 1;
});
module.exports = { CONSTRAINT_NAME, STATEMENTS, init };
