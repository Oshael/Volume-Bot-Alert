/** Stage 129 - versioned Robinhood transfer edges, bounded evidence and cursors. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_edges (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     classification_version VARCHAR(64) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     from_wallet VARCHAR(42) NOT NULL,
     to_wallet VARCHAR(42) NOT NULL,
     transfer_count BIGINT NOT NULL DEFAULT 0,
     total_amount_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
     first_block BIGINT NOT NULL,
     first_seen_at TIMESTAMPTZ NOT NULL,
     first_transaction_hash VARCHAR(66) NOT NULL,
     last_block BIGINT NOT NULL,
     last_seen_at TIMESTAMPTZ NOT NULL,
     last_transaction_hash VARCHAR(66) NOT NULL,
     largest_amount_raw NUMERIC(78,0) NOT NULL DEFAULT 0,
     largest_transaction_hash VARCHAR(66) NOT NULL,
     wallet_transfer_count BIGINT NOT NULL DEFAULT 0,
     dex_flow_count BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_edges_pkey PRIMARY KEY (
       chain, classification_version, token_address, from_wallet, to_wallet
     ),
     CONSTRAINT rh_wallet_transfer_edges_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_transfer_edges_version_check CHECK (
       classification_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_wallet_transfer_edges_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
       AND from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_wallet_transfer_edges_values_check CHECK (
       transfer_count > 0 AND total_amount_raw >= 0
       AND first_block >= 0 AND last_block >= first_block
       AND last_seen_at >= first_seen_at AND largest_amount_raw >= 0
       AND wallet_transfer_count >= 0 AND dex_flow_count >= 0
       AND wallet_transfer_count + dex_flow_count <= transfer_count
     ),
     CONSTRAINT rh_wallet_transfer_edges_hash_check CHECK (
       first_transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND last_transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND largest_transaction_hash ~ '^0x[0-9a-f]{64}$'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_edges_from
     ON robinhood_wallet_transfer_edges(
       chain, classification_version, from_wallet, updated_at DESC
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_edges_to
     ON robinhood_wallet_transfer_edges(
       chain, classification_version, to_wallet, updated_at DESC
     )`,

  `CREATE TABLE IF NOT EXISTS robinhood_wallet_relationship_evidence (
     evidence_id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42),
     left_wallet VARCHAR(42) NOT NULL,
     right_wallet VARCHAR(42) NOT NULL,
     relationship_kind VARCHAR(32) NOT NULL,
     evidence_role VARCHAR(16) NOT NULL,
     evidence_transaction_hash VARCHAR(66) NOT NULL,
     evidence_block BIGINT NOT NULL,
     evidence_log_index INTEGER NOT NULL,
     evidence_at TIMESTAMPTZ NOT NULL,
     amount_raw NUMERIC(78,0),
     score_component VARCHAR(64) NOT NULL,
     algorithm_version VARCHAR(64) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_relationship_evidence_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_relationship_evidence_token_check CHECK (
       token_address IS NULL OR (
         token_address ~ '^0x[0-9a-f]{40}$'
         AND token_address <> '0x0000000000000000000000000000000000000000'
       )
     ),
     CONSTRAINT rh_wallet_relationship_evidence_pair_check CHECK (
       left_wallet ~ '^0x[0-9a-f]{40}$'
       AND right_wallet ~ '^0x[0-9a-f]{40}$'
       AND left_wallet < right_wallet
     ),
     CONSTRAINT rh_wallet_relationship_evidence_kind_check CHECK (
       relationship_kind ~ '^[a-z0-9][a-z0-9_-]{0,31}$'
       AND score_component ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND algorithm_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND evidence_role IN ('first', 'largest', 'last', 'temporal')
     ),
     CONSTRAINT rh_wallet_relationship_evidence_position_check CHECK (
       evidence_block >= 0 AND evidence_log_index >= 0
       AND (amount_raw IS NULL OR amount_raw >= 0)
     ),
     CONSTRAINT rh_wallet_relationship_evidence_tx_check CHECK (
       evidence_transaction_hash ~ '^0x[0-9a-f]{64}$'
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_wallet_relationship_evidence_slot
     ON robinhood_wallet_relationship_evidence(
       chain, algorithm_version, COALESCE(token_address,
         '0x0000000000000000000000000000000000000000'),
       left_wallet, right_wallet, relationship_kind, evidence_role
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_relationship_evidence_token
     ON robinhood_wallet_relationship_evidence(
       chain, algorithm_version, token_address, relationship_kind, evidence_at DESC
     )`,

  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL,
     stream VARCHAR(16) NOT NULL,
     next_block BIGINT NOT NULL,
     next_transaction_index INTEGER NOT NULL DEFAULT 0,
     next_log_index INTEGER NOT NULL DEFAULT 0,
     next_block_time TIMESTAMPTZ NOT NULL,
     safe_head BIGINT,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     summarized_through_day DATE,
     lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'pending',
     state_reason VARCHAR(500),
     completed_at TIMESTAMPTZ,
     failed_at TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_cursors_pkey PRIMARY KEY (
       chain, projection_version, stream
     ),
     CONSTRAINT rh_wallet_transfer_cursors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_transfer_cursors_version_check CHECK (
       projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_wallet_transfer_cursors_stream_check CHECK (stream IN ('seed', 'live')),
     CONSTRAINT rh_wallet_transfer_cursors_position_check CHECK (
       next_block >= 0 AND next_transaction_index >= 0 AND next_log_index >= 0
       AND (safe_head IS NULL OR safe_head >= 0)
       AND (checkpoint_block IS NULL OR checkpoint_block >= 0)
       AND version >= 0
     ),
     CONSTRAINT rh_wallet_transfer_cursors_checkpoint_check CHECK (
       (checkpoint_block IS NULL) = (checkpoint_hash IS NULL)
       AND (checkpoint_hash IS NULL OR checkpoint_hash ~ '^0x[0-9a-f]{64}$')
       AND (checkpoint_block IS NULL OR checkpoint_block <= next_block)
     ),
     CONSTRAINT rh_wallet_transfer_cursors_state_check CHECK (
       lifecycle_state IN ('pending', 'running', 'complete', 'failed')
       AND (
         (lifecycle_state IN ('pending', 'running')
           AND completed_at IS NULL AND failed_at IS NULL)
         OR (lifecycle_state = 'complete'
           AND completed_at IS NOT NULL AND failed_at IS NULL)
         OR (lifecycle_state = 'failed'
           AND completed_at IS NULL AND failed_at IS NOT NULL
           AND NULLIF(BTRIM(state_reason), '') IS NOT NULL)
       )
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_cursors_work
     ON robinhood_wallet_transfer_cursors(
       chain, lifecycle_state, stream, next_block, next_transaction_index, next_log_index
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 129 Robinhood wallet transfer projection schema created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 129:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
