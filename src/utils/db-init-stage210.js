'use strict';

/** Stage 210 - bounded retention and telemetry indexes for Stage 204. */
const db = require('../models/db');

const TABLE = 'robinhood_wallet_swap_realtime_outbox';
const INDEX_NAMES = Object.freeze([
  'idx_rh_wallet_swap_realtime_outbox_retention',
  'idx_rh_wallet_swap_realtime_outbox_backlog',
  'idx_rh_wallet_swap_realtime_outbox_frontier',
]);
const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[0]}
     ON ${TABLE}(created_at, block_number, transaction_hash, log_index, block_hash)
     WHERE event_kind IN ('finalized', 'invalidate')
       AND audit_status='complete' AND status IN ('pending', 'complete')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[1]}
     ON ${TABLE}(event_kind, created_at, block_number)
     WHERE status<>'complete' OR audit_status<>'complete'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[2]}
     ON ${TABLE}(event_kind, block_number DESC) INCLUDE (published_at)
     WHERE status='complete'`,
  `ALTER TABLE ${TABLE} SET (
     autovacuum_vacuum_scale_factor = 0.01,
     autovacuum_vacuum_threshold = 5000,
     autovacuum_analyze_scale_factor = 0.02,
     autovacuum_analyze_threshold = 5000
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 210 Robinhood trade lifecycle retention created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 210:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAMES, STATEMENTS, TABLE, init };
