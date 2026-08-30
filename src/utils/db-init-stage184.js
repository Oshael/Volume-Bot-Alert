'use strict';

/** Stage 184 - accelerate Robinhood holder delta candidate selection. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_catalog_robinhood_first_seen_address
     ON token_catalog(first_seen_at ASC, address ASC)
     WHERE chain = 'robinhood'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_holder_global_excluded_token
     ON robinhood_holder_global_backfill_tokens(chain, token_address)
     WHERE status = 'excluded'`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 184 Robinhood holder delta selection indexes created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 184:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
