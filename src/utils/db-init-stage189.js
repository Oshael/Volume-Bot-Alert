'use strict';

/** Stage 189 - bounded Robinhood FDV-reference reads for processing. */
const db = require('../models/db');

const INDEX_NAME = 'idx_rh_market_observations_fdv_reference';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_market_observations (token_address, observed_at DESC)
  INCLUDE (fdv_usd)
  WHERE chain = 'robinhood'
    AND status = 'accepted'
    AND fdv_usd IS NOT NULL`;
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
  const index = result.rows[0];
  if (!index?.indisvalid || !index?.indisready) {
    throw new Error(`${INDEX_NAME} is not valid/ready`);
  }
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    await removeInvalidIndex(database);
    await database.query(CREATE_STATEMENT);
    await assertIndexReady(database);
    console.log('Stage 189 Robinhood FDV reference index created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 189:', error.message);
  process.exitCode = 1;
});

module.exports = {
  CREATE_STATEMENT, INDEX_NAME, STATEMENTS, assertIndexReady, init, removeInvalidIndex,
};
