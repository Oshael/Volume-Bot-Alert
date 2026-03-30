/**
 * Etapa 17 - Minute-bucket volume baselines.
 * Rodar com: node src/utils/db-init-stage17.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_market_volume_buckets_1m (
     token_address VARCHAR(64) NOT NULL,
     bucket_ts TIMESTAMPTZ NOT NULL,
     close_vol_5m NUMERIC(20, 2),
     close_vol_1h NUMERIC(20, 2),
     close_vol_6h NUMERIC(20, 2),
     close_vol_24h NUMERIC(20, 2),
     sample_count INTEGER NOT NULL DEFAULT 1,
     source VARCHAR(32) NOT NULL DEFAULT 'dexscreener',
     PRIMARY KEY (token_address, bucket_ts)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_volume_buckets_1m_bucket_ts
     ON token_market_volume_buckets_1m(bucket_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_volume_buckets_1m_addr_bucket_ts
     ON token_market_volume_buckets_1m(token_address, bucket_ts DESC)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 17 market volume bucket table created successfully');
    console.log('   - token_market_volume_buckets_1m');
  } catch (err) {
    console.error('Failed to create stage 17 market volume bucket table:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
