'use strict';

const db = require('../models/db');

const MIGRATION_SQL = `WITH migrated AS (
  UPDATE token_catalog
  SET source = CASE WHEN source = 'user-manual' THEN 'user-watchlist' ELSE source END,
      eligibility_state = CASE WHEN eligibility_state = 'robinhood-manual'
        THEN 'robinhood-watchlist' ELSE eligibility_state END,
      suppressed_reason = CASE WHEN suppressed_reason = 'robinhood-manual-metadata-pending'
        THEN 'robinhood-watchlist-metadata-pending' ELSE suppressed_reason END,
      metadata_updated_at = NOW()
  WHERE source = 'user-manual'
     OR eligibility_state = 'robinhood-manual'
     OR suppressed_reason = 'robinhood-manual-metadata-pending'
  RETURNING 1
)
SELECT COUNT(*)::integer AS migrated_count FROM migrated`;

async function migrate(options = {}) {
  const database = options.database || db;
  const { rows } = await database.query(MIGRATION_SQL);
  return Number(rows[0]?.migrated_count || 0);
}

async function main() {
  try {
    const migratedCount = await migrate();
    console.log(`Watchlist catalog source migration updated ${migratedCount} tokens`);
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Watchlist catalog source migration failed:', error.message);
  process.exitCode = 1;
});

module.exports = { MIGRATION_SQL, migrate };
