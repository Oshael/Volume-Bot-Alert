/** Stage 153 - directional evidence for Robinhood wallet transfer edges. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_wallet_transfer_edges
     ADD COLUMN IF NOT EXISTS first_wallet_transfer_block BIGINT,
     ADD COLUMN IF NOT EXISTS first_wallet_transfer_log_index INTEGER,
     ADD COLUMN IF NOT EXISTS first_wallet_transfer_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS first_wallet_transfer_transaction_hash VARCHAR(66),
     ADD COLUMN IF NOT EXISTS first_wallet_transfer_amount_raw NUMERIC(78,0)`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'robinhood_wallet_transfer_edges'::regclass
         AND conname = 'rh_wallet_transfer_edges_first_wallet_transfer_check'
     ) THEN
       ALTER TABLE robinhood_wallet_transfer_edges
         ADD CONSTRAINT rh_wallet_transfer_edges_first_wallet_transfer_check CHECK (
           (first_wallet_transfer_block IS NULL
             AND first_wallet_transfer_log_index IS NULL
             AND first_wallet_transfer_at IS NULL
             AND first_wallet_transfer_transaction_hash IS NULL
             AND first_wallet_transfer_amount_raw IS NULL)
           OR (first_wallet_transfer_block IS NOT NULL
             AND first_wallet_transfer_log_index IS NOT NULL
             AND first_wallet_transfer_at IS NOT NULL
             AND first_wallet_transfer_transaction_hash IS NOT NULL
             AND first_wallet_transfer_amount_raw IS NOT NULL
             AND wallet_transfer_count > 0
             AND (first_wallet_transfer_block, first_wallet_transfer_log_index)
               >= (first_block, first_log_index)
             AND (first_wallet_transfer_block, first_wallet_transfer_log_index)
               <= (last_block, last_log_index)
             AND first_wallet_transfer_at BETWEEN first_seen_at AND last_seen_at
             AND first_wallet_transfer_transaction_hash ~ '^0x[0-9a-f]{64}$'
             AND first_wallet_transfer_amount_raw >= 0)
         );
     END IF;
   END $$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 153 Robinhood directional wallet-transfer evidence created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 153:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
