/** Stage 174 - causal lineage for live possible-bundle snapshots. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_possible_bundle_states
     ADD COLUMN IF NOT EXISTS source_version BIGINT`,
  `ALTER TABLE robinhood_possible_bundle_states
     DROP CONSTRAINT IF EXISTS rh_possible_bundle_states_source_check,
     ADD CONSTRAINT rh_possible_bundle_states_source_check CHECK (
       (source_kind IS NULL AND source_run_id IS NULL AND source_version IS NULL)
       OR (source_kind = 'seed' AND source_run_id IS NOT NULL AND source_version IS NULL)
       OR (source_kind = 'live' AND source_run_id IS NULL AND source_version >= 1)
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 174 Robinhood BUNDLED live lineage created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 174:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
