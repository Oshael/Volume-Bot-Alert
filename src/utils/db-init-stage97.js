/**
 * Stage 97 - Durable launchpad attribution for catalog identities.
 * Nullable means attribution has not run; `robinhood` is the explicit fallback.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE token_catalog
     ADD COLUMN IF NOT EXISTS launchpad_id VARCHAR(32)`,
  `ALTER TABLE token_catalog
     ADD COLUMN IF NOT EXISTS launchpad_checked_at TIMESTAMPTZ`,
  `COMMENT ON COLUMN token_catalog.launchpad_id IS
     'Canonical launch origin; robinhood is the explicit unknown/direct-deploy fallback'`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 97 catalog launchpad attribution created successfully');
  } catch (error) {
    console.error('Failed to create Stage 97 catalog launchpad attribution:', error.message);
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
