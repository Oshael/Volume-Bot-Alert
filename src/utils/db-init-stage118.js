/** Stage 118 - durable rollback floor for the Robinhood holder journal. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_cursors
     ADD COLUMN IF NOT EXISTS journal_floor_block BIGINT`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'robinhood_holder_cursors_journal_floor_check'
          AND conrelid = 'robinhood_holder_cursors'::regclass
     ) THEN
       ALTER TABLE robinhood_holder_cursors
         ADD CONSTRAINT robinhood_holder_cursors_journal_floor_check CHECK (
           journal_floor_block IS NULL
           OR (journal_floor_block >= 0 AND journal_floor_block <= next_block)
         );
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 118 Robinhood holder journal floor created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 118:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
