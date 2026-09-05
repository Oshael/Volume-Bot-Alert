'use strict';

/** Stage 198 - bounded V4 tail reads for canonical liquidity valuation. */
const db = require('../models/db');

const INDEX_NAME = 'idx_rh_v4_liquidity_deltas_pool_tail';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_v4_liquidity_deltas(chain, pool_id, block_number, log_index)
  INCLUDE (tick_lower, tick_upper, liquidity_delta)`;
const STATEMENTS = Object.freeze([CREATE_STATEMENT]);

async function removeInvalidIndex(database) {
  const result = await database.query(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [INDEX_NAME]
  );
  if (result.rows[0]?.indisvalid !== false) return false;
  await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
  return true;
}

async function assertIndexReady(database) {
  const result = await database.query(
    `SELECT indisvalid, indisready
       FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [INDEX_NAME]
  );
  if (!result.rows[0]?.indisvalid || !result.rows[0]?.indisready) {
    throw new Error(`${INDEX_NAME} is not valid/ready`);
  }
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    await removeInvalidIndex(database);
    await database.query(CREATE_STATEMENT);
    await assertIndexReady(database);
    console.log('Stage 198 V4 liquidity tail index created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 198:', error.message);
  process.exitCode = 1;
});

module.exports = {
  INDEX_NAME, CREATE_STATEMENT, STATEMENTS, assertIndexReady, init, removeInvalidIndex,
};
