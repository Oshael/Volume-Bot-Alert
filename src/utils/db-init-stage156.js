/** Stage 156 - token-scoped Robinhood first-pool origin lookup. */
const db = require('../models/db');

const INDEX_NAME = 'idx_rh_pool_registry_token_origin';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_pool_registry (chain, token_address, discovery_block)`;
const STATEMENTS = Object.freeze([CREATE_STATEMENT]);

async function removeInvalidIndex() {
  const result = await db.query(
    `SELECT indisvalid
       FROM pg_index
      WHERE indexrelid = to_regclass($1)`,
    [INDEX_NAME]
  );
  if (result.rows[0]?.indisvalid !== false) return false;
  console.log(`Stage 156: removing interrupted invalid index ${INDEX_NAME}...`);
  await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
  return true;
}

async function assertIndexReady() {
  const result = await db.query(
    `SELECT indisvalid, indisready
       FROM pg_index
      WHERE indexrelid = to_regclass($1)`,
    [INDEX_NAME]
  );
  const index = result.rows[0];
  if (!index?.indisvalid || !index?.indisready) {
    throw new Error(`${INDEX_NAME} is not valid/ready`);
  }
}

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    await removeInvalidIndex();
    console.log('Stage 156: building token first-pool origin index...');
    await db.query(CREATE_STATEMENT);
    await assertIndexReady();
    console.log('Stage 156 Robinhood first-pool origin index created successfully');
  } catch (error) {
    console.error('Failed to create Stage 156 first-pool origin index:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch(() => {});

module.exports = {
  CREATE_STATEMENT, INDEX_NAME, STATEMENTS, assertIndexReady, init, removeInvalidIndex,
};
