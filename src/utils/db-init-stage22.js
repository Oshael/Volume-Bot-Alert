/**
 * Etapa 22 - Meteora current-state table.
 * Rodar com: node src/utils/db-init-stage22.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_meteora_state (
     token_address VARCHAR(64) PRIMARY KEY,
     last_checked_at TIMESTAMPTZ,
     has_pool BOOLEAN,
     current_tvl NUMERIC(20, 2),
     best_pool_address VARCHAR(128),
     pool_count INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     source VARCHAR(32) NOT NULL DEFAULT 'meteora',
     last_snapshot_at TIMESTAMPTZ,
     baseline_tvl_1h NUMERIC(20, 2),
     baseline_tvl_4h NUMERIC(20, 2),
     baseline_tvl_6h NUMERIC(20, 2),
     baseline_tvl_24h NUMERIC(20, 2),
     volume_1h NUMERIC(20, 2),
     volume_4h NUMERIC(20, 2),
     volume_24h NUMERIC(20, 2),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS last_snapshot_at TIMESTAMPTZ`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_1h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_4h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_6h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_24h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS volume_1h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS volume_4h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS volume_24h NUMERIC(20, 2)`,
  `CREATE INDEX IF NOT EXISTS idx_token_meteora_state_checked_at
     ON token_meteora_state(last_checked_at DESC NULLS LAST)`,
  `CREATE INDEX IF NOT EXISTS idx_token_meteora_state_has_pool
     ON token_meteora_state(has_pool, last_checked_at DESC NULLS LAST)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 22 Meteora current-state table created successfully');
    console.log('   - token_meteora_state');
  } catch (err) {
    console.error('Failed to create stage 22 Meteora current-state table:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
