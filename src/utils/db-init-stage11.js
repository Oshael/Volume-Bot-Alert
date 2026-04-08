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
     sample_count INTEGER NOT NULL DEFAULT 1,
     source VARCHAR(32) NOT NULL DEFAULT 'dexscreener',
     PRIMARY KEY (token_address, bucket_ts)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_buckets_1m_bucket_ts
     ON token_market_buckets_1m(bucket_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_buckets_1m_addr_bucket_ts
     ON token_market_buckets_1m(token_address, bucket_ts DESC)`
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
