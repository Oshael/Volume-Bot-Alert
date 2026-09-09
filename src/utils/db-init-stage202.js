'use strict';

/** Stage 202 - bounded autovacuum cadence for the largest high-churn tables. */
const db = require('../models/db');

const TABLES = Object.freeze([
  'token_market_volume_buckets_1m',
  'robinhood_market_buckets_1m',
  'robinhood_holder_transfer_journal',
  'robinhood_market_observations',
  'robinhood_processed_logs',
  'robinhood_head_captures',
]);

const SETTINGS = Object.freeze({
  autovacuum_vacuum_scale_factor: 0.005,
  autovacuum_vacuum_threshold: 50000,
  autovacuum_vacuum_insert_scale_factor: 0.005,
  autovacuum_vacuum_insert_threshold: 50000,
  autovacuum_analyze_scale_factor: 0.01,
  autovacuum_analyze_threshold: 50000,
  autovacuum_freeze_max_age: 150000000,
  autovacuum_vacuum_cost_delay: 2,
  autovacuum_vacuum_cost_limit: 2000,
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
    console.log('Stage 202 high-churn autovacuum tuning applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 202:', error.message);
  process.exitCode = 1;
});

module.exports = { SETTINGS, STATEMENTS, TABLES, init };
