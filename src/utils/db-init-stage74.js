/**
 * Stage 74 - Explicit Robinhood continuous-coverage origin.
 * Existing cursors restart proof at their last persisted checkpoint instead
 * of treating the row creation time as processed-chain evidence.
 * Run with: node src/utils/db-init-stage74.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_ingestion_cursors
     ADD COLUMN IF NOT EXISTS coverage_start_block BIGINT`,
  `ALTER TABLE robinhood_ingestion_cursors
     ADD COLUMN IF NOT EXISTS coverage_start_timestamp TIMESTAMPTZ`,
  `UPDATE robinhood_ingestion_cursors
   SET coverage_start_block = COALESCE(coverage_start_block, checkpoint_block),
       coverage_start_timestamp = COALESCE(coverage_start_timestamp, checkpoint_timestamp)
   WHERE checkpoint_block IS NOT NULL
     AND checkpoint_timestamp IS NOT NULL
     AND (coverage_start_block IS NULL OR coverage_start_timestamp IS NULL)`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'robinhood_ingestion_cursors'::regclass
         AND conname = 'robinhood_ingestion_cursors_coverage_pair_check'
     ) THEN
       ALTER TABLE robinhood_ingestion_cursors
         ADD CONSTRAINT robinhood_ingestion_cursors_coverage_pair_check
         CHECK (
           (coverage_start_block IS NULL) = (coverage_start_timestamp IS NULL)
         );
     END IF;

     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'robinhood_ingestion_cursors'::regclass
         AND conname = 'robinhood_ingestion_cursors_coverage_boundary_check'
     ) THEN
       ALTER TABLE robinhood_ingestion_cursors
         ADD CONSTRAINT robinhood_ingestion_cursors_coverage_boundary_check
         CHECK (
           coverage_start_block IS NULL OR (
             coverage_start_block >= 0
             AND checkpoint_block IS NOT NULL
             AND checkpoint_timestamp IS NOT NULL
             AND coverage_start_block <= checkpoint_block
             AND coverage_start_timestamp <= checkpoint_timestamp
           )
         );
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 74 Robinhood coverage origin added successfully');
  } catch (error) {
    console.error('Failed to add stage 74 Robinhood coverage origin:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init };
