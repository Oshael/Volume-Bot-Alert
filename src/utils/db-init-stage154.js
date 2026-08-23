/** Stage 154 - checkpointed directional transfer evidence replay control. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_directional_transfer_replay_runs (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL DEFAULT 'rh_transfer_v1',
     replay_version VARCHAR(64) NOT NULL DEFAULT 'rh_directional_transfer_replay_v1',
     source_from_block BIGINT NOT NULL,
     source_through_block BIGINT NOT NULL,
     source_through_hash VARCHAR(66) NOT NULL,
     range_blocks INTEGER NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'planned',
     range_count INTEGER NOT NULL DEFAULT 0,
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_directional_replay_runs_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_directional_replay_runs_version_check CHECK (
       projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND replay_version ~ '^rh_directional_transfer_replay_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_directional_replay_runs_source_check CHECK (
       source_from_block >= 0 AND source_through_block >= source_from_block
       AND source_through_hash ~ '^0x[0-9a-f]{64}$'
       AND range_blocks BETWEEN 1 AND 5000 AND range_count >= 0
     ),
     CONSTRAINT rh_directional_replay_runs_status_check CHECK (
       status IN ('planned', 'running', 'paused', 'completed', 'failed')
     ),
     CONSTRAINT rh_directional_replay_runs_lifecycle_check CHECK (
       (status = 'planned' AND started_at IS NULL AND finished_at IS NULL)
       OR (status IN ('running', 'paused') AND started_at IS NOT NULL AND finished_at IS NULL)
       OR (status IN ('completed', 'failed')
         AND started_at IS NOT NULL AND finished_at IS NOT NULL)
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_directional_replay_runs_active
     ON robinhood_directional_transfer_replay_runs(chain, projection_version)
     WHERE status IN ('planned', 'running', 'paused')`,
  `CREATE TABLE IF NOT EXISTS robinhood_directional_transfer_replay_ranges (
     id BIGSERIAL PRIMARY KEY,
     run_id BIGINT NOT NULL
       REFERENCES robinhood_directional_transfer_replay_runs(id) ON DELETE RESTRICT,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     range_start_block BIGINT NOT NULL,
     range_end_block BIGINT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     blocks_scanned BIGINT NOT NULL DEFAULT 0,
     transfers_scanned BIGINT NOT NULL DEFAULT 0,
     edges_considered BIGINT NOT NULL DEFAULT 0,
     edges_written BIGINT NOT NULL DEFAULT 0,
     completed_through_block BIGINT,
     completed_through_hash VARCHAR(66),
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_directional_replay_ranges_identity
       UNIQUE (run_id, range_start_block, range_end_block),
     CONSTRAINT rh_directional_replay_ranges_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_directional_replay_ranges_bounds_check CHECK (
       range_start_block >= 0 AND range_end_block >= range_start_block
     ),
     CONSTRAINT rh_directional_replay_ranges_status_check CHECK (
       status IN ('pending', 'leased', 'completed', 'failed')
     ),
     CONSTRAINT rh_directional_replay_ranges_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_directional_replay_ranges_counts_check CHECK (
       attempt_count >= 0 AND blocks_scanned >= 0 AND transfers_scanned >= 0
       AND edges_considered >= 0 AND edges_written >= 0
     ),
     CONSTRAINT rh_directional_replay_ranges_completion_check CHECK (
       (status = 'completed' AND completed_at IS NOT NULL
         AND completed_through_block = range_end_block
         AND completed_through_hash ~ '^0x[0-9a-f]{64}$')
       OR (status <> 'completed' AND completed_at IS NULL
         AND completed_through_block IS NULL AND completed_through_hash IS NULL)
     ),
     CONSTRAINT rh_directional_replay_ranges_error_check CHECK (
       (last_error_code IS NULL) = (last_error_message IS NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_directional_replay_ranges_claim
     ON robinhood_directional_transfer_replay_ranges(
       run_id, next_attempt_at, range_start_block
     ) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_directional_replay_ranges_lease
     ON robinhood_directional_transfer_replay_ranges(run_id, lease_until)
     WHERE status = 'leased'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_directional_replay_ranges_progress
     ON robinhood_directional_transfer_replay_ranges(run_id, status, range_start_block)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 154 Robinhood directional transfer replay control created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 154:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
