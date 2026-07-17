/**
 * Stage 75 - Structured rolling-volume coverage provenance.
 * The constraint accepts valid legacy string states while requiring new
 * structured entries to keep state and source together. It stays NOT VALID
 * to avoid scanning the historical volume table during deployment.
 * Run with: node src/utils/db-init-stage75.js
 */
const db = require('../models/db');

const WINDOWS = Object.freeze(['1m', '5m', '1h', '6h', '24h']);
const STATES_SQL = "'complete', 'partial', 'unavailable'";
const ENTRY_CHECKS = WINDOWS.map((window) => `(
  NOT window_coverage ? '${window}'
  OR (
    jsonb_typeof(window_coverage -> '${window}') = 'string'
    AND window_coverage ->> '${window}' IN (${STATES_SQL})
  )
  OR (
    jsonb_typeof(window_coverage -> '${window}') = 'object'
    AND (window_coverage -> '${window}') ? 'state'
    AND (window_coverage -> '${window}') ? 'source'
    AND (window_coverage -> '${window}') - ARRAY['state', 'source'] = '{}'::jsonb
    AND window_coverage -> '${window}' ->> 'state' IN (${STATES_SQL})
    AND NULLIF(BTRIM(window_coverage -> '${window}' ->> 'source'), '') IS NOT NULL
  )
)`).join('\nAND ');

const STATEMENTS = Object.freeze([
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'token_market_volume_buckets_1m'::regclass
         AND conname = 'token_market_volume_buckets_1m_coverage_entries_check'
     ) THEN
       ALTER TABLE token_market_volume_buckets_1m
         ADD CONSTRAINT token_market_volume_buckets_1m_coverage_entries_check
         CHECK (
           jsonb_typeof(window_coverage) = 'object'
           AND window_coverage - ARRAY['1m', '5m', '1h', '6h', '24h'] = '{}'::jsonb
           AND ${ENTRY_CHECKS}
         ) NOT VALID;
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 75 structured volume coverage provenance added successfully');
  } catch (error) {
    console.error('Failed to add stage 75 structured volume coverage:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { ENTRY_CHECKS, STATEMENTS, WINDOWS, init };
