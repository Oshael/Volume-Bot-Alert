/**
 * Stage 80 - Meteora eligibility indexes.
 * Run with: node src/utils/db-init-stage80.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_catalog_meteora_catalog_eligible
     ON token_catalog(id)
     WHERE chain = 'solana'
       AND is_active_monitor_candidate = TRUE
       AND COALESCE(last_mcap, 0) >= 100000
       AND (
         COALESCE(source, '') <> 'gmgn'
         OR eligibility_state IN ('dex-low', 'dex-normal', 'dex-high')
       )`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_meteora_state_active_pool_address
     ON token_meteora_state(token_address)
     WHERE has_pool = TRUE`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 80 Meteora eligibility indexes created successfully');
  } catch (error) {
    console.error('Failed to create stage 80 Meteora eligibility indexes:', error.message);
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
