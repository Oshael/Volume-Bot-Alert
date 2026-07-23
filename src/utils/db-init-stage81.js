/**
 * Stage 81 - Unbounded token catalog price precision.
 * Aligns the shared catalog with on-chain market buckets whose prices are NUMERIC.
 * Run with: node src/utils/db-init-stage81.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE token_catalog
     ALTER COLUMN last_price TYPE NUMERIC
     USING last_price::NUMERIC`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 81 token catalog price precision updated successfully');
  } catch (error) {
    console.error('Failed to update stage 81 token catalog price precision:', error.message);
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
