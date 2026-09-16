'use strict';

/** Stage 227 - replace the bloated head-state retention index. */
const db = require('../models/db');
const stage224 = require('./db-init-stage224');

const OLD_INDEX_NAME = 'idx_rh_head_capture_states_retention';
const INDEX_NAME = stage224.INDEX_NAMES[2];
const CREATE_STATEMENT = stage224.STATEMENTS.at(-1);

async function removeInvalidReplacement(database) {
  const result = await database.query(
    'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)',
    [INDEX_NAME]
  );
  if (result.rows[0]?.indisvalid !== false) return;
  await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
}

async function assertReplacementReady(database) {
  const result = await database.query(
    `SELECT index.indisvalid, index.indisready, pg_get_indexdef(index.indexrelid) AS definition
       FROM pg_index index WHERE index.indexrelid = to_regclass($1)`,
    [INDEX_NAME]
  );
  const row = result.rows[0];
  const definition = String(row?.definition || '').toLowerCase();
  if (!row?.indisvalid || !row?.indisready
      || !definition.includes('retention_eligible_at')
      || !definition.includes('include (terminal_at)')) {
    throw new Error(`Stage 227 replacement index is not ready: ${INDEX_NAME}`);
  }
}

async function assertLegacyRetired(database) {
  const result = await database.query('SELECT to_regclass($1) AS index_name', [OLD_INDEX_NAME]);
  if (result.rows[0]?.index_name != null) {
    throw new Error(`Stage 227 legacy index still exists: ${OLD_INDEX_NAME}`);
  }
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    await removeInvalidReplacement(database);
    await database.query(CREATE_STATEMENT);
    await assertReplacementReady(database);
    await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${OLD_INDEX_NAME}`);
    await assertLegacyRetired(database);
    console.log('Stage 227 Robinhood head-state retention index replaced successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 227:', error.message);
  process.exitCode = 1;
});

module.exports = {
  CREATE_STATEMENT, INDEX_NAME, OLD_INDEX_NAME, assertLegacyRetired,
  assertReplacementReady, init, removeInvalidReplacement,
};
