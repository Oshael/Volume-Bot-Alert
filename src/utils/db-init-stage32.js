const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS pumpfun_fast_5x_detections (
     rule_key VARCHAR(64) NOT NULL DEFAULT 'pumpfun-fast-5x',
     token_address VARCHAR(64) NOT NULL,
     symbol VARCHAR(64),
     name VARCHAR(160),
     migration_started_at TIMESTAMPTZ,
     alert_triggered_at TIMESTAMPTZ NOT NULL,
     alert_mcap NUMERIC(20, 2),
     alert_multiple_from_first_mcap NUMERIC(20, 6),
     score NUMERIC(12, 4),
     reason VARCHAR(64),
     evidence_at_alert JSONB NOT NULL DEFAULT '{}'::jsonb,
     latest_mcap_since_alert NUMERIC(20, 2),
     latest_bucket_at TIMESTAMPTZ,
     max_mcap_since_alert NUMERIC(20, 2),
     max_mcap_bucket_at TIMESTAMPTZ,
     max_x_since_alert NUMERIC(20, 6),
     first_matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     matched_runs INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (rule_key, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pumpfun_fast_5x_detections_alert_triggered
     ON pumpfun_fast_5x_detections(alert_triggered_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pumpfun_fast_5x_detections_max_x
     ON pumpfun_fast_5x_detections(max_x_since_alert DESC NULLS LAST)`,
  `CREATE INDEX IF NOT EXISTS idx_pumpfun_fast_5x_detections_updated
     ON pumpfun_fast_5x_detections(last_updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 32 PumpFun fast 5x detections created successfully');
    console.log('   - pumpfun_fast_5x_detections');
  } catch (err) {
    console.error('Failed to create stage 32 PumpFun fast 5x detections:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
