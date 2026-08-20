/** Stage 142 - accelerate global holder handoff checks against applied journal history. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_holder_journal_applied_token_block
     ON robinhood_holder_transfer_journal(
       chain, token_address, block_number ASC
     ) WHERE applied = true`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 142 Robinhood holder applied-journal index created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 142:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
