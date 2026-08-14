/** Stage 130 - exact within-block frontiers for Robinhood transfer edges. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_wallet_transfer_edges
     ADD COLUMN IF NOT EXISTS first_log_index INTEGER,
     ADD COLUMN IF NOT EXISTS last_log_index INTEGER,
     ADD COLUMN IF NOT EXISTS largest_log_index INTEGER`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM robinhood_wallet_transfer_edges
       WHERE first_log_index IS NULL
          OR last_log_index IS NULL
          OR largest_log_index IS NULL
     ) THEN
       RAISE EXCEPTION USING
         MESSAGE = 'Stage 130 cannot infer transfer edge log indexes',
         HINT = 'Rebuild the inactive Stage 129 projection before retrying';
     END IF;
   END $$`,
  `ALTER TABLE robinhood_wallet_transfer_edges
     ALTER COLUMN first_log_index SET NOT NULL,
     ALTER COLUMN last_log_index SET NOT NULL,
     ALTER COLUMN largest_log_index SET NOT NULL`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'robinhood_wallet_transfer_edges'::regclass
         AND conname = 'rh_wallet_transfer_edges_log_index_check'
     ) THEN
       ALTER TABLE robinhood_wallet_transfer_edges
         ADD CONSTRAINT rh_wallet_transfer_edges_log_index_check CHECK (
           first_log_index >= 0
           AND last_log_index >= 0
           AND largest_log_index >= 0
         );
     END IF;
   END $$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 130 Robinhood transfer edge frontiers created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 130:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
