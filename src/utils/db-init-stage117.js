/** Stage 117 - reversible provenance for the Robinhood holder journal. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_transfer_journal
     ADD COLUMN IF NOT EXISTS from_last_block_before BIGINT,
     ADD COLUMN IF NOT EXISTS from_last_transaction_hash_before VARCHAR(66),
     ADD COLUMN IF NOT EXISTS from_last_log_index_before INTEGER,
     ADD COLUMN IF NOT EXISTS to_last_block_before BIGINT,
     ADD COLUMN IF NOT EXISTS to_last_transaction_hash_before VARCHAR(66),
     ADD COLUMN IF NOT EXISTS to_last_log_index_before INTEGER`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'rh_holder_journal_from_provenance_check'
          AND conrelid = 'robinhood_holder_transfer_journal'::regclass
     ) THEN
       ALTER TABLE robinhood_holder_transfer_journal
         ADD CONSTRAINT rh_holder_journal_from_provenance_check CHECK (
           (from_last_block_before IS NULL
             AND from_last_transaction_hash_before IS NULL
             AND from_last_log_index_before IS NULL)
           OR (from_last_block_before >= 0
             AND from_last_transaction_hash_before ~ '^0x[0-9a-f]{64}$'
             AND from_last_log_index_before >= 0)
         );
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'rh_holder_journal_to_provenance_check'
          AND conrelid = 'robinhood_holder_transfer_journal'::regclass
     ) THEN
       ALTER TABLE robinhood_holder_transfer_journal
         ADD CONSTRAINT rh_holder_journal_to_provenance_check CHECK (
           (to_last_block_before IS NULL
             AND to_last_transaction_hash_before IS NULL
             AND to_last_log_index_before IS NULL)
           OR (to_last_block_before >= 0
             AND to_last_transaction_hash_before ~ '^0x[0-9a-f]{64}$'
             AND to_last_log_index_before >= 0)
         );
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 117 Robinhood holder rollback provenance created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 117:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
