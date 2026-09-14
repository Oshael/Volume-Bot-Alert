'use strict';

/** Stage 218 - retention-safe quarantine for invalid liquidity currencies. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_pool_liquidity_refresh_queue
     DROP CONSTRAINT IF EXISTS rh_pool_liquidity_refresh_queue_lifecycle_check,
     ADD CONSTRAINT rh_pool_liquidity_refresh_queue_lifecycle_check CHECK (
       (status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL)
       OR (status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       OR (status = 'quarantined' AND lease_owner IS NULL AND lease_until IS NULL
         AND last_error IS NOT NULL
         AND last_error->>'code' = 'liquidity_currency_decimals_unavailable')
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_pool_liquidity_refresh_queue_quarantine_recheck
     ON robinhood_pool_liquidity_refresh_queue(
       next_attempt_at, dirty_from_block, protocol, market_key
     ) WHERE status = 'quarantined'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 218 Robinhood liquidity quarantine created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 218:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
