/**
 * Stage 108 - Online blocked-frontier index for the Robinhood processing queue.
 *
 * The hot derived frontier must consider dead letters without scanning millions
 * of terminal captures. Pending already has the Stage 107 claim-order index;
 * this partial index gives blocked rows the same bounded frontier lookup.
 * Run with: node src/utils/db-init-stage108.js
 */
const db = require('../models/db');

const INDEX_NAME = 'idx_robinhood_head_captures_blocked_frontier';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_head_captures (block_number, transaction_index, log_index)
  WHERE processing_status = 'blocked' AND stream = 'market'`;
const STATEMENTS = Object.freeze([CREATE_STATEMENT]);

async function assertIndexReady() {
  const result = await db.query(
    `SELECT indexrelid::regclass::text AS index_name, indisvalid, indisready
       FROM pg_index
       WHERE indexrelid = to_regclass($1)`,
    [INDEX_NAME]
  );
  const index = result.rows[0];
  if (!index?.indisvalid || !index?.indisready) {
    throw new Error(
      `${INDEX_NAME} is not valid/ready; drop the invalid index concurrently and rerun Stage 108`
    );
  }
}

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    await db.query(CREATE_STATEMENT);
    await assertIndexReady();
    console.log('Stage 108 Robinhood blocked frontier index created successfully');
  } catch (error) {
    console.error('Failed to create Stage 108 Robinhood blocked frontier index:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { CREATE_STATEMENT, INDEX_NAME, STATEMENTS, assertIndexReady, init };
