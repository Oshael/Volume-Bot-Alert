/** Stage 126 - versioned Robinhood wallet financial positions and projection cursors. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_token_positions (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     quantity_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
     cost_basis_usd NUMERIC NOT NULL DEFAULT 0,
     realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
     buy_volume_usd NUMERIC NOT NULL DEFAULT 0,
     sell_proceeds_usd NUMERIC NOT NULL DEFAULT 0,
     buy_mcap_weighted_sum NUMERIC NOT NULL DEFAULT 0,
     buy_mcap_weight_usd NUMERIC NOT NULL DEFAULT 0,
     sell_mcap_weighted_sum NUMERIC NOT NULL DEFAULT 0,
     sell_mcap_weight_usd NUMERIC NOT NULL DEFAULT 0,
     buy_tx_count BIGINT NOT NULL DEFAULT 0,
     sell_tx_count BIGINT NOT NULL DEFAULT 0,
     zero_cost_received_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
     zero_cost_sold_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
     cost_basis_source VARCHAR(32) NOT NULL DEFAULT 'swap_only',
     quality VARCHAR(32) NOT NULL DEFAULT 'exact_swap_only',
     through_block BIGINT NOT NULL,
     through_log_index BIGINT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_positions_pkey PRIMARY KEY (
       chain, projection_version, token_address, wallet_address
     ),
     CONSTRAINT rh_wallet_positions_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_positions_version_check CHECK (
       projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_wallet_positions_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_wallet_positions_values_check CHECK (
       quantity_raw >= 0 AND cost_basis_usd >= 0 AND buy_volume_usd >= 0
       AND sell_proceeds_usd >= 0 AND buy_mcap_weighted_sum >= 0
       AND buy_mcap_weight_usd >= 0 AND sell_mcap_weighted_sum >= 0
       AND sell_mcap_weight_usd >= 0 AND buy_tx_count >= 0 AND sell_tx_count >= 0
       AND zero_cost_received_raw >= 0 AND zero_cost_sold_raw >= 0
       AND through_block >= 0 AND through_log_index >= 0
       AND (quantity_raw > 0 OR cost_basis_usd = 0)
     ),
     CONSTRAINT rh_wallet_positions_source_check CHECK (
       cost_basis_source IN ('swap_only', 'transferred_assumed_zero')
     ),
     CONSTRAINT rh_wallet_positions_quality_check CHECK (
       quality IN ('exact_swap_only', 'transfer_adjusted', 'transferred_assumed_zero',
         'partial_history', 'reconciliation_mismatch', 'unavailable')
     )
   )`,
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_position_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL,
     stream VARCHAR(16) NOT NULL,
     next_block BIGINT NOT NULL,
     safe_head BIGINT,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'pending',
     state_reason VARCHAR(500),
     completed_at TIMESTAMPTZ,
     abandoned_at TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_position_cursors_pkey PRIMARY KEY (
       chain, projection_version, stream
     ),
     CONSTRAINT rh_wallet_position_cursors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_position_cursors_version_check CHECK (
       projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_wallet_position_cursors_stream_check CHECK (stream IN ('seed', 'live')),
     CONSTRAINT rh_wallet_position_cursors_blocks_check CHECK (
       next_block >= 0 AND (safe_head IS NULL OR safe_head >= 0)
       AND (checkpoint_block IS NULL OR checkpoint_block >= 0) AND version >= 0
     ),
     CONSTRAINT rh_wallet_position_cursors_checkpoint_check CHECK (
       (checkpoint_block IS NULL) = (checkpoint_hash IS NULL)
       AND (checkpoint_hash IS NULL OR checkpoint_hash ~ '^0x[0-9a-f]{64}$')
     ),
     CONSTRAINT rh_wallet_position_cursors_lifecycle_check CHECK (
       lifecycle_state IN ('pending', 'running', 'complete', 'abandoned')
     ),
     CONSTRAINT rh_wallet_position_cursors_terminal_check CHECK (
       (lifecycle_state IN ('pending', 'running')
         AND completed_at IS NULL AND abandoned_at IS NULL)
       OR (lifecycle_state = 'complete'
         AND completed_at IS NOT NULL AND abandoned_at IS NULL)
       OR (lifecycle_state = 'abandoned'
         AND completed_at IS NULL AND abandoned_at IS NOT NULL
         AND NULLIF(BTRIM(state_reason), '') IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_position_cursors_work
     ON robinhood_wallet_position_cursors(chain, lifecycle_state, stream, next_block)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 126 Robinhood wallet position schema created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 126:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
