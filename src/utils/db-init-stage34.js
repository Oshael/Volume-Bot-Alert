const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS pumpfun_combo_confirmation_detections (
     token_address VARCHAR(64) PRIMARY KEY,
     symbol VARCHAR(64),
     name VARCHAR(160),
     migration_started_at TIMESTAMPTZ,
     combo_triggered_at TIMESTAMPTZ NOT NULL,
     combo_mcap NUMERIC(20, 2),
     score NUMERIC(12, 4),
     reason VARCHAR(64),
     evidence_at_trigger JSONB NOT NULL DEFAULT '{}'::jsonb,
     latest_mcap_since_trigger NUMERIC(20, 2),
     latest_bucket_at TIMESTAMPTZ,
     max_mcap_since_trigger NUMERIC(20, 2),
     max_mcap_bucket_at TIMESTAMPTZ,
     max_x_since_trigger NUMERIC(20, 6),
     first_matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     matched_runs INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pumpfun_combo_confirmation_triggered
     ON pumpfun_combo_confirmation_detections(combo_triggered_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pumpfun_combo_confirmation_max_x
     ON pumpfun_combo_confirmation_detections(max_x_since_trigger DESC NULLS LAST)`,
  `CREATE INDEX IF NOT EXISTS idx_pumpfun_combo_confirmation_updated
     ON pumpfun_combo_confirmation_detections(last_updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 34 PumpFun combo confirmation detections created successfully');
    console.log('   - pumpfun_combo_confirmation_detections');
  } catch (err) {
    console.error('Failed to create stage 34 PumpFun combo confirmation detections:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
