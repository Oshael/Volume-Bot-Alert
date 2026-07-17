/**
 * Stage 72 - Persistent Robinhood metadata-source checks.
 * Negative checks must survive restarts so missing images do not cause hot loops.
 * Run with: node src/utils/db-init-stage72.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE token_catalog
     ADD COLUMN IF NOT EXISTS robinhood_blockscout_checked_at TIMESTAMPTZ`,
  `ALTER TABLE token_catalog
     ADD COLUMN IF NOT EXISTS robinhood_dexscreener_checked_at TIMESTAMPTZ`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 72 Robinhood metadata source checks added successfully');
  } catch (error) {
    console.error('Failed to add stage 72 Robinhood metadata source checks:', error.message);
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
