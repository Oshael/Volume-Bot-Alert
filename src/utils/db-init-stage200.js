'use strict';

/** Stage 200 - safe bounded retention for Robinhood raw market evidence. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_backfill_aggregation_outbox
     DROP CONSTRAINT IF EXISTS robinhood_backfill_aggregation_outbox_observation_fkey,
     ADD CONSTRAINT robinhood_backfill_aggregation_outbox_observation_fkey
       FOREIGN KEY (chain, transaction_hash, log_index)
       REFERENCES robinhood_market_observations(chain, transaction_hash, log_index)
       ON DELETE CASCADE NOT VALID`,
  `ALTER TABLE robinhood_market_observations SET (
     autovacuum_vacuum_scale_factor = 0.005,
     autovacuum_vacuum_threshold = 50000,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_analyze_threshold = 50000
   )`,
  `ALTER TABLE robinhood_processed_logs SET (
     autovacuum_vacuum_scale_factor = 0.005,
     autovacuum_vacuum_threshold = 50000,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_analyze_threshold = 50000
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 200 Robinhood retention safety created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 200:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
