'use strict';

/** Stage 196 - replace the oversized holder rollback B-tree with a BRIN range index. */
const db = require('../models/db');

const BRIN_INDEX = 'idx_rh_holder_journal_block_brin';
const LEGACY_INDEX = 'idx_robinhood_holder_journal_rollback';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${BRIN_INDEX}
  ON robinhood_holder_transfer_journal USING BRIN (block_number)
  WITH (pages_per_range = 32, autosummarize = on)`;
const DROP_STATEMENT = `DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_INDEX}`;
const STATEMENTS = Object.freeze([CREATE_STATEMENT, DROP_STATEMENT]);

async function removeInvalidReplacement(database) {
  const result = await database.query(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [BRIN_INDEX]
  );
  if (result.rows[0]?.indisvalid !== false) return false;
  await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${BRIN_INDEX}`);
  return true;
}

async function assertReplacementReady(database) {
  const result = await database.query(
    `SELECT indisvalid, indisready
       FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [BRIN_INDEX]
  );
  if (!result.rows[0]?.indisvalid || !result.rows[0]?.indisready) {
    throw new Error(`${BRIN_INDEX} is not valid/ready; legacy index was preserved`);
  }
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    await removeInvalidReplacement(database);
    await database.query(CREATE_STATEMENT);
    await assertReplacementReady(database);
    await database.query(DROP_STATEMENT);
    console.log('Stage 196 holder rollback BRIN replacement created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 196:', error.message);
  process.exitCode = 1;
});

module.exports = {
  BRIN_INDEX, LEGACY_INDEX, CREATE_STATEMENT, DROP_STATEMENT, STATEMENTS,
  assertReplacementReady, init, removeInvalidReplacement,
};
