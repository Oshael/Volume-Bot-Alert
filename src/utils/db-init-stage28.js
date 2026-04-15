const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS bid_zone_runs (
     id SERIAL PRIMARY KEY,
     started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     completed_at TIMESTAMPTZ,
     status VARCHAR(16) NOT NULL,
     requested_hours INTEGER NOT NULL,
     min_mcap BIGINT NOT NULL DEFAULT 90000,
     min_vol_1h BIGINT NOT NULL DEFAULT 1000,
     min_vol_24h BIGINT NOT NULL DEFAULT 10000,
     candidate_count INTEGER NOT NULL DEFAULT 0,
     result_count INTEGER NOT NULL DEFAULT 0,
     notes TEXT,
     error_message TEXT,
     triggered_by VARCHAR(32) NOT NULL DEFAULT 'worker'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bid_zone_runs_lookup
     ON bid_zone_runs(status, requested_hours, min_mcap, min_vol_1h, min_vol_24h, completed_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS bid_zone_results (
     run_id INTEGER NOT NULL REFERENCES bid_zone_runs(id) ON DELETE CASCADE,
     token_address VARCHAR(64) NOT NULL,
     rank INTEGER NOT NULL,
     symbol VARCHAR(64),
     name VARCHAR(160),
     score NUMERIC(20, 4),
     mcap NUMERIC(20, 2),
     catalog_mcap NUMERIC(20, 2),
     window_mcap NUMERIC(20, 2),
     volume_1h NUMERIC(20, 2),
     volume_6h NUMERIC(20, 2),
     volume_24h NUMERIC(20, 2),
     support_level_mcap NUMERIC(20, 2),
     resistance_level_mcap NUMERIC(20, 2),
     robust_range_pct NUMERIC(20, 4),
     recent_range_pct NUMERIC(20, 4),
     close_drift_pct NUMERIC(20, 4),
     support_distance_pct NUMERIC(20, 4),
     resistance_distance_pct NUMERIC(20, 4),
     support_touch_clusters INTEGER NOT NULL DEFAULT 0,
     coverage_ratio NUMERIC(20, 6),
     bucket_count INTEGER NOT NULL DEFAULT 0,
     sample_count INTEGER NOT NULL DEFAULT 0,
     expected_bucket_count INTEGER NOT NULL DEFAULT 0,
     age_hours NUMERIC(20, 4),
     window_hours_used INTEGER NOT NULL DEFAULT 0,
     minimum_window_hours INTEGER NOT NULL DEFAULT 0,
     liquidity_penalty NUMERIC(20, 4),
     volume_1h_penalty NUMERIC(20, 4),
     monitor_priority VARCHAR(16),
     first_bucket_at TIMESTAMPTZ,
     last_bucket_at TIMESTAMPTZ,
     diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
     PRIMARY KEY (run_id, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bid_zone_results_run_rank
     ON bid_zone_results(run_id, rank ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_bid_zone_results_token_run
     ON bid_zone_results(token_address, run_id DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 28 bid-zone tables created successfully');
    console.log('   - bid_zone_runs');
    console.log('   - bid_zone_results');
  } catch (err) {
    console.error('Failed to create stage 28 bid-zone tables:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
