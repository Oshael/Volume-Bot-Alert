/**
 * Stage 107 - Online market-claim index for the Robinhood head queue.
 *
 * The processing claim is ordered by block/transaction/log. The original
 * pending index starts with next_attempt_at, so PostgreSQL can fall back to the
 * large reorg index and filter millions of terminal rows. This partial index
 * matches the market claim's predicate and ordering while leaving discovery's
 * existing claim index intact.
 * Run with: node src/utils/db-init-stage107.js
 */
const db = require('../models/db');

const INDEX_NAME = 'idx_robinhood_head_captures_market_claim';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_head_captures (
    block_number, transaction_index, log_index, next_attempt_at
  )
  WHERE processing_status = 'pending' AND stream = 'market'`;
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
      `${INDEX_NAME} is not valid/ready; drop the invalid index concurrently and rerun Stage 107`
    );
  }
}

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    await db.query(CREATE_STATEMENT);
    await assertIndexReady();
    console.log('Stage 107 Robinhood market claim index created successfully');
  } catch (error) {
    console.error('Failed to create Stage 107 Robinhood market claim index:', error.message);
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
