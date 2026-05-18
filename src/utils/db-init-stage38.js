/**
 * Etapa 38 - Aggregated market buckets for sparkline reads.
 * Rodar com: node src/utils/db-init-stage38.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_market_buckets_agg (
     token_address VARCHAR(64) NOT NULL,
     granularity_minutes INTEGER NOT NULL CHECK (granularity_minutes IN (5, 15, 30)),
     bucket_ts TIMESTAMPTZ NOT NULL,
     pair_address VARCHAR(64),
     open_mcap NUMERIC(20, 2),
     high_mcap NUMERIC(20, 2),
     low_mcap NUMERIC(20, 2),
     close_mcap NUMERIC(20, 2),
     open_price NUMERIC(20, 12),
     high_price NUMERIC(20, 12),
     low_price NUMERIC(20, 12),
     close_price NUMERIC(20, 12),
     sample_count INTEGER NOT NULL DEFAULT 1,
     source VARCHAR(32) NOT NULL DEFAULT 'aggregate',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (token_address, granularity_minutes, bucket_ts)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_buckets_agg_lookup
     ON token_market_buckets_agg(token_address, granularity_minutes, bucket_ts DESC)
     WHERE close_mcap IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_buckets_agg_sparkline_cover
     ON token_market_buckets_agg(token_address, granularity_minutes, bucket_ts DESC)
     INCLUDE (pair_address, close_mcap)
     WHERE close_mcap IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_buckets_agg_bucket_ts
     ON token_market_buckets_agg(granularity_minutes, bucket_ts DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 38 aggregated market bucket table created successfully');
    console.log('   - token_market_buckets_agg');
  } catch (err) {
    console.error('Failed to create stage 38 aggregated market bucket table:', err.message);
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
