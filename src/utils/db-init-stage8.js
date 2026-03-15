const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_meteora_snapshots (
     id SERIAL PRIMARY KEY,
     token_address VARCHAR(64) NOT NULL,
     ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     total_tvl NUMERIC(20, 2),
     best_pool_address VARCHAR(128),
     pool_count INTEGER NOT NULL DEFAULT 0,
     source VARCHAR(32) NOT NULL DEFAULT 'meteora'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_meteora_snapshots_addr_ts
     ON token_meteora_snapshots(token_address, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_meteora_snapshots_ts
     ON token_meteora_snapshots(ts DESC)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 8 Meteora snapshot table created successfully');
    console.log('   - token_meteora_snapshots');
  } catch (err) {
    console.error('Failed to create stage 8 Meteora snapshot table:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
