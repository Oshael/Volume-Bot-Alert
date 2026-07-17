/**
 * Stage 71 - Website metadata for the shared token catalog.
 * Pair URLs and project websites are distinct contracts.
 * Run with: node src/utils/db-init-stage71.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE token_catalog
     ADD COLUMN IF NOT EXISTS last_website_url TEXT`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 71 token catalog website field added successfully');
  } catch (error) {
    console.error('Failed to add stage 71 token catalog website field:', error.message);
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
