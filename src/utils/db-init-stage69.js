/**
 * Stage 69 - Keep fully diluted valuation separate from market cap.
 * Robinhood on-chain supply currently supports FDV, not circulating market cap.
 * Run with: node src/utils/db-init-stage69.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE token_catalog
     ADD COLUMN IF NOT EXISTS last_fdv NUMERIC`,
  `COMMENT ON COLUMN token_catalog.last_fdv IS
     'Fully diluted valuation in USD; never substitute for circulating market cap'`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 69 token catalog FDV field added successfully');
  } catch (error) {
    console.error('Failed to add stage 69 token catalog FDV field:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init };
