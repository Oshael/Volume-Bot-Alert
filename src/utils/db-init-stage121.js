const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_holder_journal_pending_token
     ON robinhood_holder_transfer_journal(
       chain, token_address, block_number ASC, transaction_index ASC, log_index ASC
     ) WHERE applied = false`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 121 Robinhood holder pending-token index created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 121:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
