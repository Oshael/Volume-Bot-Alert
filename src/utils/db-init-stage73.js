/**
 * Stage 73 - Solana rolling-volume coverage provenance.
 * Existing rows remain conservative because the empty object proves no window.
 * Run with: node src/utils/db-init-stage73.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE token_market_volume_buckets_1m
     ADD COLUMN IF NOT EXISTS window_coverage JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'token_market_volume_buckets_1m'::regclass
         AND conname = 'token_market_volume_buckets_1m_window_coverage_check'
     ) THEN
       ALTER TABLE token_market_volume_buckets_1m
         ADD CONSTRAINT token_market_volume_buckets_1m_window_coverage_check
         CHECK (jsonb_typeof(window_coverage) = 'object') NOT VALID;
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 73 rolling-volume coverage provenance added successfully');
  } catch (error) {
    console.error('Failed to add stage 73 rolling-volume coverage:', error.message);
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
