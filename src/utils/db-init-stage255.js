'use strict';

/** Stage 255 - bound dead-tuple autovacuum eligibility on Robinhood derived tables. */
const db = require('../models/db');

const TABLES = Object.freeze([
  'robinhood_market_buckets_agg',
  'robinhood_holder_realtime_outbox',
  'robinhood_liquidity_realtime_outbox',
]);

const SETTINGS = Object.freeze({
  autovacuum_vacuum_threshold: 350000,
  autovacuum_vacuum_scale_factor: 0,
});

const STATEMENTS = Object.freeze(TABLES.map((table) => `ALTER TABLE public.${table} SET (
  autovacuum_vacuum_threshold = ${SETTINGS.autovacuum_vacuum_threshold},
  autovacuum_vacuum_scale_factor = ${SETTINGS.autovacuum_vacuum_scale_factor}
)`));

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query('COMMIT');
    console.log('Stage 255 Robinhood derived-table autovacuum thresholds applied');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 255:', error.message);
  process.exitCode = 1;
});

module.exports = { SETTINGS, STATEMENTS, TABLES, init };
