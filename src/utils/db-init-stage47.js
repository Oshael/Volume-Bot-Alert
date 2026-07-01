/**
 * Stage 47 - Expanded aggregate market bucket granularities.
 * Run with: node src/utils/db-init-stage47.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_market_buckets_agg
     DROP CONSTRAINT IF EXISTS token_market_buckets_agg_granularity_minutes_check`,
  `ALTER TABLE token_market_buckets_agg
     ADD CONSTRAINT token_market_buckets_agg_granularity_minutes_check
     CHECK (granularity_minutes IN (5, 15, 30, 60, 240, 1440))
     NOT VALID`,
  `ALTER TABLE token_market_buckets_agg
     VALIDATE CONSTRAINT token_market_buckets_agg_granularity_minutes_check`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 47 expanded aggregate market bucket granularities applied successfully');
    console.log('   - token_market_buckets_agg granularity_minutes check');
  } catch (err) {
    console.error('Failed to apply stage 47 aggregate market bucket granularities:', err.message);
    process.exit(1);
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) {
  init();
}

module.exports = { init, STATEMENTS };
