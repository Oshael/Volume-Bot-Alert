/** Stage 167 - native funding evidence and resumable BUNDLED seed campaigns. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_native_funding_events (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     from_wallet VARCHAR(42) NOT NULL,
     to_wallet VARCHAR(42) NOT NULL,
     value_wei NUMERIC(78,0) NOT NULL,
     evidence_version VARCHAR(64) NOT NULL DEFAULT 'rh_native_funding_v1',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_native_funding_events_pkey PRIMARY KEY (
       chain, transaction_hash, transaction_index, block_time
     ),
     CONSTRAINT rh_native_funding_events_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_native_funding_events_position_check CHECK (
       block_number >= 0 AND transaction_index >= 0
     ),
     CONSTRAINT rh_native_funding_events_hash_check CHECK (
       block_hash ~ '^0x[0-9a-f]{64}$'
       AND transaction_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_native_funding_events_address_check CHECK (
       from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_native_funding_events_value_check CHECK (value_wei > 0),
     CONSTRAINT rh_native_funding_events_version_check CHECK (
       evidence_version ~ '^rh_native_funding_v[1-9][0-9]*$'
     )
   ) PARTITION BY RANGE (block_time)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_native_funding_from_time
     ON robinhood_native_funding_events(chain, from_wallet, block_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_native_funding_to_time
     ON robinhood_native_funding_events(chain, to_wallet, block_time DESC)`,
  `CREATE TABLE IF NOT EXISTS robinhood_native_funding_edges (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     from_wallet VARCHAR(42) NOT NULL,
     to_wallet VARCHAR(42) NOT NULL,
     evidence_version VARCHAR(64) NOT NULL,
     first_block_number BIGINT NOT NULL,
     first_block_hash VARCHAR(66) NOT NULL,
     first_block_time TIMESTAMPTZ NOT NULL,
     first_transaction_hash VARCHAR(66) NOT NULL,
     first_transaction_index INTEGER NOT NULL,
     last_block_number BIGINT NOT NULL,
     last_block_hash VARCHAR(66) NOT NULL,
     last_block_time TIMESTAMPTZ NOT NULL,
     last_transaction_hash VARCHAR(66) NOT NULL,
     last_transaction_index INTEGER NOT NULL,
     transfer_count BIGINT NOT NULL,
     total_value_wei NUMERIC(78,0) NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_native_funding_edges_pkey PRIMARY KEY (
       chain, from_wallet, to_wallet, evidence_version
     ),
     CONSTRAINT rh_native_funding_edges_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_native_funding_edges_address_check CHECK (
       from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$' AND from_wallet <> to_wallet
     ),
     CONSTRAINT rh_native_funding_edges_version_check CHECK (
       evidence_version ~ '^rh_native_funding_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_native_funding_edges_position_check CHECK (
       first_block_number >= 0 AND first_transaction_index >= 0
       AND last_block_number >= first_block_number AND last_transaction_index >= 0
       AND (last_block_number > first_block_number
         OR last_transaction_index >= first_transaction_index)
       AND last_block_time >= first_block_time
     ),
     CONSTRAINT rh_native_funding_edges_hash_check CHECK (
       first_block_hash ~ '^0x[0-9a-f]{64}$'
       AND last_block_hash ~ '^0x[0-9a-f]{64}$'
       AND first_transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND last_transaction_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_native_funding_edges_value_check CHECK (
       transfer_count > 0 AND total_value_wei > 0
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_native_funding_edges_to
     ON robinhood_native_funding_edges(chain, to_wallet, evidence_version)`,
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_funding_backfill_runs (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     rule_version VARCHAR(64) NOT NULL DEFAULT 'rh_possible_bundle_v1',
     evidence_version VARCHAR(64) NOT NULL DEFAULT 'rh_native_funding_v1',
     source_from_block BIGINT NOT NULL,
     source_through_block BIGINT NOT NULL,
     source_through_hash VARCHAR(66) NOT NULL,
     lookback_blocks BIGINT NOT NULL,
     batch_blocks INTEGER NOT NULL,
     concurrency INTEGER NOT NULL,
     candidate_count INTEGER NOT NULL,
     range_count INTEGER NOT NULL,
     blocks_total BIGINT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'planned',
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_funding_runs_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_bundle_funding_runs_version_check CHECK (
       rule_version ~ '^rh_possible_bundle_v[1-9][0-9]*$'
       AND evidence_version ~ '^rh_native_funding_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_bundle_funding_runs_bounds_check CHECK (
       source_from_block >= 0 AND source_through_block >= source_from_block
       AND source_through_hash ~ '^0x[0-9a-f]{64}$'
       AND lookback_blocks >= 0 AND batch_blocks BETWEEN 1 AND 100
       AND concurrency BETWEEN 1 AND 16 AND candidate_count >= 0
       AND range_count >= 0 AND blocks_total >= 0
     ),
     CONSTRAINT rh_bundle_funding_runs_status_check CHECK (
       status IN ('planned', 'running', 'completed', 'failed')
     ),
     CONSTRAINT rh_bundle_funding_runs_lifecycle_check CHECK (
       (status = 'planned' AND started_at IS NULL AND finished_at IS NULL)
       OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
       OR (status IN ('completed', 'failed')
         AND started_at IS NOT NULL AND finished_at IS NOT NULL)
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_bundle_funding_runs_active
     ON robinhood_bundle_funding_backfill_runs(chain)
     WHERE status IN ('planned', 'running')`,
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_funding_backfill_candidates (
     run_id BIGINT NOT NULL REFERENCES robinhood_bundle_funding_backfill_runs(id)
       ON DELETE RESTRICT,
     token_address VARCHAR(42) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     launch_block BIGINT NOT NULL,
     first_buy_block BIGINT NOT NULL,
     first_buy_transaction_index INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_funding_candidates_pkey PRIMARY KEY (
       run_id, token_address, wallet_address
     ),
     CONSTRAINT rh_bundle_funding_candidates_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_bundle_funding_candidates_position_check CHECK (
       launch_block >= 0 AND first_buy_block BETWEEN launch_block AND launch_block + 3
       AND first_buy_transaction_index >= 0
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_candidates_buy
     ON robinhood_bundle_funding_backfill_candidates(
       run_id, first_buy_block, first_buy_transaction_index
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_funding_backfill_ranges (
     run_id BIGINT NOT NULL REFERENCES robinhood_bundle_funding_backfill_runs(id)
       ON DELETE RESTRICT,
     range_index INTEGER NOT NULL,
     from_block BIGINT NOT NULL,
     through_block BIGINT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     completed_through_hash VARCHAR(66),
     blocks_scanned BIGINT NOT NULL DEFAULT 0,
     native_transfers_scanned BIGINT NOT NULL DEFAULT 0,
     raw_events_written BIGINT NOT NULL DEFAULT 0,
     edges_written BIGINT NOT NULL DEFAULT 0,
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_funding_ranges_pkey PRIMARY KEY (run_id, range_index),
     CONSTRAINT rh_bundle_funding_ranges_bounds_check CHECK (
       range_index >= 0 AND from_block >= 0 AND through_block >= from_block
     ),
     CONSTRAINT rh_bundle_funding_ranges_status_check CHECK (
       status IN ('pending', 'leased', 'completed', 'failed')
     ),
     CONSTRAINT rh_bundle_funding_ranges_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_bundle_funding_ranges_counts_check CHECK (
       attempt_count >= 0 AND blocks_scanned >= 0 AND native_transfers_scanned >= 0
       AND raw_events_written >= 0 AND edges_written >= 0
     ),
     CONSTRAINT rh_bundle_funding_ranges_terminal_check CHECK (
       (status IN ('completed', 'failed')) = (completed_at IS NOT NULL)
       AND (status = 'completed') = (completed_through_hash IS NOT NULL)
       AND (status <> 'completed'
         OR blocks_scanned = through_block - from_block + 1)
       AND (completed_through_hash IS NULL
         OR completed_through_hash ~ '^0x[0-9a-f]{64}$')
       AND (last_error_code IS NULL) = (last_error_message IS NULL)
       AND (status <> 'failed' OR last_error_code IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_ranges_claim
     ON robinhood_bundle_funding_backfill_ranges(run_id, next_attempt_at, range_index)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_ranges_lease
     ON robinhood_bundle_funding_backfill_ranges(run_id, lease_until)
     WHERE status = 'leased'`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 167 Robinhood native funding persistence created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 167:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
