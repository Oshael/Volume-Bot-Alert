/**
 * Stage 92 - Robinhood observation attribution index.
 * Adds the index the wallet-attribution reader needs to walk accepted swaps by
 * block ascending. Without it, reading observations by block scans the whole
 * 71M-row table. Built CONCURRENTLY; heavy on production (minutes, several GB).
 * Run with: node src/utils/db-init-stage92.js
 */
const db = require('../models/db');

const INDEX_NAME = 'idx_robinhood_market_observations_attribution';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
     ON robinhood_market_observations (chain, status, block_number, log_index)`;
const STATEMENTS = Object.freeze([CREATE_STATEMENT]);

// A CONCURRENTLY build that is interrupted leaves an INVALID index that blocks
// a clean rerun. Drop it first so re-running the stage rebuilds from scratch.
async function removeInvalidIndex(indexName = INDEX_NAME) {
  const result = await db.query(
    `SELECT index_state.indisvalid
       FROM pg_index index_state
      WHERE index_state.indexrelid = to_regclass($1)`,
    [indexName]
  );
  if (result.rows[0]?.indisvalid !== false) return false;
  console.log(`Stage 92: removing interrupted invalid index ${indexName}...`);
  await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
  return true;
}

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    await removeInvalidIndex(INDEX_NAME);
    console.log('Stage 92: building observation attribution index...');
    await db.query(CREATE_STATEMENT);
    console.log('Stage 92 Robinhood observation attribution index created successfully');
  } catch (error) {
    console.error('Failed to create stage 92 observation attribution index:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = {
  INDEX_NAME, CREATE_STATEMENT, STATEMENTS, removeInvalidIndex, init,
};
