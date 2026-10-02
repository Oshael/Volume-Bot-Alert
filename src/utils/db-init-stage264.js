'use strict';

/** Stage 264 - bounded active V4 manager lookups for transfer context. */
const db = require('../models/db');

const INDEX_NAME = 'idx_rh_pool_registry_active_v4_manager';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_pool_registry (chain, origin_address)
  WHERE active = true AND protocol = 'uniswap-v4' AND origin_address IS NOT NULL`;
const STATEMENTS = Object.freeze([CREATE_STATEMENT]);

async function inspect(database) {
  const result = await database.query(
    `SELECT indisvalid, indisready
       FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [INDEX_NAME]
  );
  return result.rows[0] || null;
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    const current = await inspect(database);
    if (current && (!current.indisvalid || !current.indisready)) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
    }
    await database.query(CREATE_STATEMENT);
    const ready = await inspect(database);
    if (!ready?.indisvalid || !ready?.indisready) {
      throw new Error(`Stage 264 index is not ready: ${INDEX_NAME}`);
    }
    console.log('Stage 264 Robinhood active V4 manager index created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 264:', error.message);
  process.exitCode = 1;
});

module.exports = { CREATE_STATEMENT, INDEX_NAME, STATEMENTS, init, inspect };
