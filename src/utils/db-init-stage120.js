/** Stage 120 - durable global Robinhood holder backfill campaign and cohort. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_holder_global_backfill_runs (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     status VARCHAR(16) NOT NULL DEFAULT 'frozen',
     catalog_cutoff TIMESTAMPTZ NOT NULL,
     next_block BIGINT NOT NULL DEFAULT 0,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     barrier_block BIGINT,
     barrier_checkpoint_block BIGINT,
     barrier_checkpoint_hash VARCHAR(66),
     barrier_attached_at TIMESTAMPTZ,
     cohort_token_count BIGINT NOT NULL DEFAULT 0,
     telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
     version BIGINT NOT NULL DEFAULT 0,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_global_runs_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_global_runs_status_check CHECK (
       status IN ('frozen', 'scanning', 'attached', 'materializing', 'paused', 'completed')
     ),
     CONSTRAINT rh_holder_global_runs_cursor_check CHECK (
       next_block >= 0 AND version >= 0 AND cohort_token_count >= 0
       AND (checkpoint_block IS NULL OR checkpoint_block >= 0 AND checkpoint_block < next_block)
     ),
     CONSTRAINT rh_holder_global_runs_checkpoint_check CHECK (
       (checkpoint_block IS NULL) = (checkpoint_hash IS NULL)
       AND (checkpoint_hash IS NULL OR checkpoint_hash ~ '^0x[0-9a-f]{64}$')
     ),
     CONSTRAINT rh_holder_global_runs_barrier_check CHECK (
       (barrier_block IS NULL AND barrier_checkpoint_block IS NULL
         AND barrier_checkpoint_hash IS NULL AND barrier_attached_at IS NULL)
       OR (barrier_block > 0 AND barrier_checkpoint_block = barrier_block - 1
         AND barrier_checkpoint_hash ~ '^0x[0-9a-f]{64}$' AND barrier_attached_at IS NOT NULL)
     ),
     CONSTRAINT rh_holder_global_runs_telemetry_check
       CHECK (jsonb_typeof(telemetry) = 'object'),
     CONSTRAINT rh_holder_global_runs_completion_check CHECK (
       (status = 'completed') = (completed_at IS NOT NULL)
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_holder_global_runs_active
     ON robinhood_holder_global_backfill_runs(chain)
     WHERE status <> 'completed'`,
  `CREATE TABLE IF NOT EXISTS robinhood_holder_global_backfill_tokens (
     run_id BIGINT NOT NULL,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     holder_count BIGINT NOT NULL DEFAULT 0,
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     exclusion_reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_global_tokens_pkey PRIMARY KEY (run_id, chain, token_address),
     CONSTRAINT rh_holder_global_tokens_run_fkey FOREIGN KEY (run_id)
       REFERENCES robinhood_holder_global_backfill_runs(id) ON DELETE RESTRICT,
     CONSTRAINT rh_holder_global_tokens_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_global_tokens_address_check
       CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT rh_holder_global_tokens_count_check CHECK (holder_count >= 0),
     CONSTRAINT rh_holder_global_tokens_status_check
       CHECK (status IN ('active', 'excluded', 'materialized', 'completed')),
     CONSTRAINT rh_holder_global_tokens_exclusion_check CHECK (
       (status = 'excluded') = (exclusion_reason IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_global_tokens_work
     ON robinhood_holder_global_backfill_tokens(run_id, status, token_address)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 120 Robinhood holder global backfill schema created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 120:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
