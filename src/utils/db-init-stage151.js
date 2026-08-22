/** Stage 151 - checkpointed and lease-safe Robinhood first-buy backfill. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_first_buy_backfill_runs (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     evidence_version VARCHAR(32) NOT NULL DEFAULT 'rh_first_buy_v1',
     source_from TIMESTAMPTZ NOT NULL,
     source_through TIMESTAMPTZ NOT NULL,
     range_seconds INTEGER NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'planned',
     range_count INTEGER NOT NULL DEFAULT 0,
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_first_buy_backfill_runs_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_first_buy_backfill_runs_evidence_check
       CHECK (evidence_version ~ '^rh_first_buy_v[1-9][0-9]*$'),
     CONSTRAINT rh_first_buy_backfill_runs_range_check CHECK (
       source_from < source_through AND range_seconds BETWEEN 60 AND 86400
       AND range_count >= 0
     ),
     CONSTRAINT rh_first_buy_backfill_runs_status_check
       CHECK (status IN ('planned', 'running', 'paused', 'completed', 'failed')),
     CONSTRAINT rh_first_buy_backfill_runs_lifecycle_check CHECK (
       (status = 'planned' AND started_at IS NULL AND finished_at IS NULL)
       OR (status IN ('running', 'paused') AND started_at IS NOT NULL AND finished_at IS NULL)
       OR (status IN ('completed', 'failed') AND started_at IS NOT NULL AND finished_at IS NOT NULL)
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_first_buy_backfill_runs_active
     ON robinhood_first_buy_backfill_runs(chain)
     WHERE status IN ('planned', 'running', 'paused')`,
  `CREATE TABLE IF NOT EXISTS robinhood_first_buy_backfill_ranges (
     id BIGSERIAL PRIMARY KEY,
     run_id BIGINT NOT NULL REFERENCES robinhood_first_buy_backfill_runs(id) ON DELETE RESTRICT,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     range_start TIMESTAMPTZ NOT NULL,
     range_end TIMESTAMPTZ NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     rows_scanned BIGINT NOT NULL DEFAULT 0,
     facts_considered BIGINT NOT NULL DEFAULT 0,
     facts_written BIGINT NOT NULL DEFAULT 0,
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_first_buy_backfill_ranges_identity
       UNIQUE (run_id, range_start, range_end),
     CONSTRAINT rh_first_buy_backfill_ranges_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_first_buy_backfill_ranges_bounds_check CHECK (range_start < range_end),
     CONSTRAINT rh_first_buy_backfill_ranges_status_check
       CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
     CONSTRAINT rh_first_buy_backfill_ranges_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_first_buy_backfill_ranges_counts_check CHECK (
       attempt_count >= 0 AND rows_scanned >= 0
       AND facts_considered >= 0 AND facts_written >= 0
     ),
     CONSTRAINT rh_first_buy_backfill_ranges_completion_check CHECK (
       (status = 'completed') = (completed_at IS NOT NULL)
     ),
     CONSTRAINT rh_first_buy_backfill_ranges_error_check CHECK (
       (last_error_code IS NULL) = (last_error_message IS NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_first_buy_backfill_ranges_claim
     ON robinhood_first_buy_backfill_ranges(run_id, next_attempt_at, range_start)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_first_buy_backfill_ranges_lease
     ON robinhood_first_buy_backfill_ranges(run_id, lease_until)
     WHERE status = 'leased'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_first_buy_backfill_ranges_progress
     ON robinhood_first_buy_backfill_ranges(run_id, status, range_start)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 151 Robinhood first-buy backfill control created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 151:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
