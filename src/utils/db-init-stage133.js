/** Stage 133 - durable origin frontier for Robinhood wallet-swap cursors. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_wallet_swap_cursors
     ADD COLUMN IF NOT EXISTS origin_block BIGINT`,
  `DO $constraints$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'robinhood_wallet_swap_cursors_origin_check'
     ) THEN
       ALTER TABLE robinhood_wallet_swap_cursors
         ADD CONSTRAINT robinhood_wallet_swap_cursors_origin_check CHECK (
           origin_block IS NULL OR (origin_block >= 0 AND origin_block <= next_block)
         );
     END IF;
   END
   $constraints$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 133 Robinhood wallet-swap cursor origins created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 133:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
