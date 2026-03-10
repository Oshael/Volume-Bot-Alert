const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_market_snapshots (
     id SERIAL PRIMARY KEY,
     token_address VARCHAR(64) NOT NULL,
     ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     mcap NUMERIC(20, 2),
     price NUMERIC(20, 12),
     vol_5m NUMERIC(20, 2),
     vol_1h NUMERIC(20, 2),
     vol_6h NUMERIC(20, 2),
     vol_24h NUMERIC(20, 2),
     source VARCHAR(32) NOT NULL DEFAULT 'dexscreener'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_addr_ts
     ON token_market_snapshots(token_address, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_snapshots_ts
     ON token_market_snapshots(ts DESC)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 7 snapshot tables created successfully');
    console.log('   - token_market_snapshots');
  } catch (err) {
    console.error('Failed to create stage 7 snapshot tables:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
