/** Stage 127 - partition-aware time frontier for Robinhood wallet position cursors. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_wallet_position_cursors
     ADD COLUMN IF NOT EXISTS next_block_time TIMESTAMPTZ`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 127 Robinhood wallet position time frontier created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 127:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
