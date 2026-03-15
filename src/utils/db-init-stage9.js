const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS monitor_priority VARCHAR(16) NOT NULL DEFAULT 'dormant'`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_vol_5m NUMERIC(20, 2)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_vol_1h NUMERIC(20, 2)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_vol_6h NUMERIC(20, 2)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_vol_24h NUMERIC(20, 2)`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_priority_due
     ON token_catalog(next_evaluation_at ASC, last_vol_24h DESC NULLS LAST)`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_monitor_priority
     ON token_catalog(monitor_priority)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 9 catalog priority fields created successfully');
    console.log('   - token_catalog priority fields');
  } catch (err) {
    console.error('Failed to create stage 9 catalog priority fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
