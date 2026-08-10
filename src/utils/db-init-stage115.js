/** Stage 115 - independent cursor for historical launchpad creator backfill. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `DO $migration$
   BEGIN
     ALTER TABLE robinhood_direct_creator_cursors
       DROP CONSTRAINT IF EXISTS robinhood_direct_creator_cursors_stream_check;
     ALTER TABLE robinhood_direct_creator_cursors
       ALTER COLUMN stream TYPE VARCHAR(32);
     ALTER TABLE robinhood_direct_creator_cursors
       ADD CONSTRAINT robinhood_direct_creator_cursors_stream_check
       CHECK (stream IN ('live', 'launchpad_backfill'));
   END
   $migration$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 115 Robinhood launchpad creator backfill cursor created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 115:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
