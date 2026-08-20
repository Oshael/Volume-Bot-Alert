/** Stage 141 - durable start of complete Robinhood holder Transfer buffering. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_cursors
     ADD COLUMN IF NOT EXISTS buffer_floor_block BIGINT`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'robinhood_holder_cursors_buffer_floor_check'
          AND conrelid = 'robinhood_holder_cursors'::regclass
     ) THEN
       ALTER TABLE robinhood_holder_cursors
         ADD CONSTRAINT robinhood_holder_cursors_buffer_floor_check CHECK (
           buffer_floor_block IS NULL
           OR (buffer_floor_block >= 0 AND buffer_floor_block <= next_block)
         );
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 141 Robinhood holder Transfer buffer floor created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 141:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
