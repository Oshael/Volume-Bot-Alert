/** Stage 166 - durable launch-anchor catch-up campaigns and token claims. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_launch_anchor_backfill_runs (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     evidence_version VARCHAR(32) NOT NULL DEFAULT 'rh_launch_anchor_v1',
     source_through_block BIGINT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'planned',
     target_count INTEGER NOT NULL DEFAULT 0,
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_launch_anchor_backfill_runs_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT rh_launch_anchor_backfill_runs_evidence_check
       CHECK (evidence_version ~ '^rh_launch_anchor_v[1-9][0-9]*$'),
     CONSTRAINT rh_launch_anchor_backfill_runs_values_check
       CHECK (source_through_block >= 0 AND target_count >= 0),
     CONSTRAINT rh_launch_anchor_backfill_runs_status_check
       CHECK (status IN ('planned', 'running', 'completed', 'failed')),
     CONSTRAINT rh_launch_anchor_backfill_runs_lifecycle_check CHECK (
       (status = 'planned' AND started_at IS NULL AND finished_at IS NULL)
       OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
       OR (status IN ('completed', 'failed')
         AND started_at IS NOT NULL AND finished_at IS NOT NULL)
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_launch_anchor_backfill_runs_active
     ON robinhood_launch_anchor_backfill_runs(chain)
     WHERE status IN ('planned', 'running')`,
  `CREATE TABLE IF NOT EXISTS robinhood_launch_anchor_backfill_targets (
     run_id BIGINT NOT NULL
       REFERENCES robinhood_launch_anchor_backfill_runs(id) ON DELETE RESTRICT,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     first_pool_block BIGINT NOT NULL,
     source_through_block BIGINT NOT NULL,
     source_through_hash VARCHAR(66) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     anchor_block BIGINT,
     swaps_considered BIGINT NOT NULL DEFAULT 0,
     anchors_written SMALLINT NOT NULL DEFAULT 0,
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_launch_anchor_backfill_targets_pkey
       PRIMARY KEY (run_id, token_address),
     CONSTRAINT rh_launch_anchor_backfill_targets_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT rh_launch_anchor_backfill_targets_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_launch_anchor_backfill_targets_source_check CHECK (
       first_pool_block >= 0 AND source_through_block >= first_pool_block
       AND source_through_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_launch_anchor_backfill_targets_status_check
       CHECK (status IN ('pending', 'leased', 'completed', 'unavailable', 'failed')),
     CONSTRAINT rh_launch_anchor_backfill_targets_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_launch_anchor_backfill_targets_counts_check CHECK (
       attempt_count >= 0 AND swaps_considered >= 0 AND anchors_written BETWEEN 0 AND 1
     ),
     CONSTRAINT rh_launch_anchor_backfill_targets_error_check
       CHECK ((last_error_code IS NULL) = (last_error_message IS NULL))
   )`,
  `ALTER TABLE robinhood_launch_anchor_backfill_targets
     DROP CONSTRAINT IF EXISTS rh_launch_anchor_backfill_targets_completion_check,
     ADD CONSTRAINT rh_launch_anchor_backfill_targets_completion_check CHECK (
       (status IN ('completed', 'unavailable', 'failed')) = (completed_at IS NOT NULL)
       AND (status = 'completed') = (
         anchor_block IS NOT NULL AND anchors_written = 1
       )
       AND (anchor_block IS NULL
         OR anchor_block BETWEEN first_pool_block AND source_through_block)
       AND (status NOT IN ('unavailable', 'failed') OR last_error_code IS NOT NULL)
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_launch_anchor_backfill_targets_claim
     ON robinhood_launch_anchor_backfill_targets(
       run_id, next_attempt_at, token_address
     ) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_launch_anchor_backfill_targets_lease
     ON robinhood_launch_anchor_backfill_targets(run_id, lease_until)
     WHERE status = 'leased'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_launch_anchor_backfill_targets_progress
     ON robinhood_launch_anchor_backfill_targets(run_id, status, token_address)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 166 Robinhood launch-anchor backfill control created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 166:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
