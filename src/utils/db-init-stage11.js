const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_market_buckets_1m (
     token_address VARCHAR(64) NOT NULL,
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
     close_liquidity_usd NUMERIC(20, 2),
     gmgn_lock_percent NUMERIC(20, 8),
     gmgn_burn_ratio NUMERIC(20, 8),
     gmgn_burn_status VARCHAR(32),
     gmgn_creator_close BOOLEAN,
     gmgn_creator_token_status VARCHAR(64),
     sample_count INTEGER NOT NULL DEFAULT 1,
     source VARCHAR(32) NOT NULL DEFAULT 'dexscreener',
     PRIMARY KEY (token_address, bucket_ts)
   )`,
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS pair_address VARCHAR(64)`,
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS close_liquidity_usd NUMERIC(20, 2)`,
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS gmgn_lock_percent NUMERIC(20, 8)`,
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS gmgn_burn_ratio NUMERIC(20, 8)`,
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS gmgn_burn_status VARCHAR(32)`,
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS gmgn_creator_close BOOLEAN`,
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS gmgn_creator_token_status VARCHAR(64)`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_buckets_1m_bucket_ts
     ON token_market_buckets_1m(bucket_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_buckets_1m_addr_bucket_ts
     ON token_market_buckets_1m(token_address, bucket_ts DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_buckets_1m_liquidity_recent
     ON token_market_buckets_1m(token_address, bucket_ts DESC)
     INCLUDE (close_liquidity_usd, sample_count, source)
     WHERE close_liquidity_usd IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_buckets_1m_gmgn_lp_recent
     ON token_market_buckets_1m(token_address, bucket_ts DESC)
     INCLUDE (
       gmgn_lock_percent,
       gmgn_burn_ratio,
       gmgn_burn_status,
       gmgn_creator_close,
       gmgn_creator_token_status,
       sample_count,
       source
     )
     WHERE source = 'gmgn'
       AND gmgn_lock_percent IS NOT NULL
       AND gmgn_burn_ratio IS NOT NULL
       AND gmgn_burn_status IS NOT NULL
       AND gmgn_creator_close IS NOT NULL
       AND gmgn_creator_token_status IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_buckets_1m_sparkline_cover
     ON token_market_buckets_1m(token_address, bucket_ts DESC)
     INCLUDE (pair_address, close_mcap)
     WHERE close_mcap IS NOT NULL`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 11 market bucket tables created successfully');
    console.log('   - token_market_buckets_1m');
  } catch (err) {
    console.error('Failed to create stage 11 market bucket tables:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
