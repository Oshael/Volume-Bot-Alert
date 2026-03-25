const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS lateralization_runs (
     id SERIAL PRIMARY KEY,
     started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     completed_at TIMESTAMPTZ,
     status VARCHAR(16) NOT NULL,
     requested_hours INTEGER NOT NULL,
     min_mcap BIGINT NOT NULL DEFAULT 90000,
     min_vol_24h BIGINT NOT NULL DEFAULT 10000,
     candidate_count INTEGER NOT NULL DEFAULT 0,
     result_count INTEGER NOT NULL DEFAULT 0,
     notes TEXT,
     error_message TEXT,
     triggered_by VARCHAR(32) NOT NULL DEFAULT 'worker'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_lateralization_runs_lookup
     ON lateralization_runs(status, requested_hours, min_mcap, min_vol_24h, completed_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS lateralization_results (
     run_id INTEGER NOT NULL REFERENCES lateralization_runs(id) ON DELETE CASCADE,
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
     range_pct NUMERIC(20, 4),
     range_limit_pct NUMERIC(20, 4),
     drift_pct NUMERIC(20, 4),
     drift_limit_pct NUMERIC(20, 4),
     coverage_ratio NUMERIC(20, 6),
     bucket_count INTEGER NOT NULL DEFAULT 0,
     sample_count INTEGER NOT NULL DEFAULT 0,
     expected_bucket_count INTEGER NOT NULL DEFAULT 0,
     age_hours NUMERIC(20, 4),
     current_position_pct NUMERIC(20, 4),
     window_hours_used INTEGER NOT NULL DEFAULT 0,
     minimum_window_hours INTEGER NOT NULL DEFAULT 0,
     liquidity_penalty NUMERIC(20, 4),
     monitor_priority VARCHAR(16),
     first_bucket_at TIMESTAMPTZ,
     last_bucket_at TIMESTAMPTZ,
     diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
     PRIMARY KEY (run_id, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_lateralization_results_run_rank
     ON lateralization_results(run_id, rank ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_lateralization_results_token_run
     ON lateralization_results(token_address, run_id DESC)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 12 lateralization tables created successfully');
    console.log('   - lateralization_runs');
    console.log('   - lateralization_results');
  } catch (err) {
    console.error('Failed to create stage 12 lateralization tables:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
