'use strict';
const db = require('../models/db');
const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_coverage_pending
    ADD COLUMN IF NOT EXISTS admitted_tail_from_block BIGINT`,
  `ALTER TABLE robinhood_holder_coverage_pending
    DROP CONSTRAINT IF EXISTS rh_holder_coverage_pending_status_check,
    DROP CONSTRAINT IF EXISTS rh_holder_local_admission_check,
    ADD CONSTRAINT rh_holder_coverage_pending_status_check CHECK (
      (status='pending' AND reason='coverage_and_handoff_unconfirmed') OR
      (status='covered' AND reason='local_live_handoff') OR
      (status='excluded' AND reason IN ('incompatible_transfer','canonical_contract',
        'robinhood_tokenized_asset','admin_blocked'))),
    ADD CONSTRAINT rh_holder_local_admission_check CHECK (
      (status='excluded' AND admitted_tail_from_block IS NULL) OR
      (status='pending' AND (admitted_tail_from_block IS NULL OR admitted_tail_from_block > from_block)) OR
      (status='covered' AND admitted_tail_from_block IS NOT NULL AND admitted_tail_from_block > from_block))`,
]);
async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='1s'");
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end();
  }
}
if (require.main === module) init().catch((error) => {
  console.error('Stage 266 local holder admission failed:', error.message);
  process.exitCode = 1;
});
module.exports = { STATEMENTS, init };
