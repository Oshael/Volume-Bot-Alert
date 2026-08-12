/** Stage 122 - durable lifecycle for Robinhood wallet-attribution watermarks. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_wallet_swap_cursors
     ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'pending',
     ADD COLUMN IF NOT EXISTS state_reason VARCHAR(500),
     ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ`,
  `DO $constraints$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'robinhood_wallet_swap_cursors_lifecycle_check'
     ) THEN
       ALTER TABLE robinhood_wallet_swap_cursors
         ADD CONSTRAINT robinhood_wallet_swap_cursors_lifecycle_check CHECK (
           lifecycle_state IN ('pending', 'running', 'complete', 'abandoned')
         );
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'robinhood_wallet_swap_cursors_terminal_check'
     ) THEN
       ALTER TABLE robinhood_wallet_swap_cursors
         ADD CONSTRAINT robinhood_wallet_swap_cursors_terminal_check CHECK (
           (lifecycle_state IN ('pending', 'running')
             AND completed_at IS NULL AND abandoned_at IS NULL)
           OR (lifecycle_state = 'complete'
             AND completed_at IS NOT NULL AND abandoned_at IS NULL)
           OR (lifecycle_state = 'abandoned'
             AND completed_at IS NULL AND abandoned_at IS NOT NULL
             AND NULLIF(BTRIM(state_reason), '') IS NOT NULL)
         );
     END IF;
   END
   $constraints$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 122 Robinhood wallet watermark lifecycle created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 122:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
