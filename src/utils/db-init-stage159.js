/** Stage 159 - published frontier for token-scoped transfer repairs. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_wallet_transfer_token_coverage
     ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
  `DO $constraints$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'rh_wallet_transfer_token_coverage_published_check'
     ) THEN
       ALTER TABLE robinhood_wallet_transfer_token_coverage
         ADD CONSTRAINT rh_wallet_transfer_token_coverage_published_check CHECK (
           published_at IS NULL OR (
             status = 'complete' AND next_block = source_through_block + 1
             AND completed_at IS NOT NULL
           )
         );
     END IF;
   END
   $constraints$`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_token_coverage_publish
     ON robinhood_wallet_transfer_token_coverage(
       chain, projection_version, source_through_block, token_address
     ) WHERE status = 'complete' AND published_at IS NULL AND attempt_count > 0`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 159 Robinhood token repair publication frontier created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 159:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
