'use strict';

/** Stage 214 - holder realtime lifecycle terminalization. */
const db = require('../models/db');
const { TABLE } = require('../models/robinhood-holder-realtime-outbox');

const STATEMENTS = Object.freeze([
  `ALTER TABLE ${TABLE}
     ADD COLUMN IF NOT EXISTS terminalized_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_holder_realtime_outbox_unterminalized
     ON ${TABLE}(live_through_block, token_address, ledger_version)
     WHERE event_kind='observed' AND terminalized_at IS NULL`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 214 Robinhood holder realtime lifecycle applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 214:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, TABLE, init };
