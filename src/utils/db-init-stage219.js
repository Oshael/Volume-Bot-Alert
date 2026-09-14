'use strict';

/** Stage 219 - early and I/O-throttled autovacuum for Robinhood high-churn tables. */
const db = require('../models/db');

const TABLES = Object.freeze([
  'robinhood_chain_events',
  'robinhood_market_observations',
  'robinhood_processed_logs',
  'token_market_volume_buckets_1m',
  'robinhood_market_buckets_1m',
  'robinhood_head_captures',
  'robinhood_holder_transfer_journal',
  'robinhood_token_holder_daily_snapshots',
]);

// At current production cardinalities this starts cleanup after roughly
// 105k-330k changed rows instead of allowing the PostgreSQL defaults to build
// up millions of dead tuples. The cost settings deliberately trade completion
// time for predictable coexistence with chain capture and live processing.
const SETTINGS = Object.freeze({
  autovacuum_vacuum_scale_factor: 0.001,
  autovacuum_vacuum_threshold: 100000,
  autovacuum_vacuum_insert_scale_factor: 0.002,
  autovacuum_vacuum_insert_threshold: 100000,
  autovacuum_analyze_scale_factor: 0.005,
  autovacuum_analyze_threshold: 100000,
  autovacuum_freeze_max_age: 150000000,
  autovacuum_vacuum_cost_delay: 10,
  autovacuum_vacuum_cost_limit: 300,
});

const settingSql = Object.entries(SETTINGS)
  .map(([name, value]) => `${name} = ${value}`)
  .join(',\n     ');
const STATEMENTS = Object.freeze(TABLES.map((table) => (
  `ALTER TABLE ${table} SET (\n     ${settingSql}\n   )`
)));

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 219 throttled Robinhood autovacuum tuning applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 219:', error.message);
  process.exitCode = 1;
});

module.exports = { SETTINGS, STATEMENTS, TABLES, init };
