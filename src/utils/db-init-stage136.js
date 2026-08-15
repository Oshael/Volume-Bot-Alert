/** Stage 136 - immutable audit ledger for applied Robinhood transfer reclassifications. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_reclassifications (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index INTEGER NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     from_wallet VARCHAR(42) NOT NULL,
     to_wallet VARCHAR(42) NOT NULL,
     amount_raw NUMERIC(78,0) NOT NULL,
     from_transfer_kind VARCHAR(32) NOT NULL,
     from_classification_version VARCHAR(64) NOT NULL,
     to_transfer_kind VARCHAR(32) NOT NULL,
     to_classification_version VARCHAR(64) NOT NULL,
     transition_version VARCHAR(64) NOT NULL,
     decision_reason VARCHAR(64) NOT NULL,
     decision_evidence JSONB NOT NULL,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_reclassifications_pkey PRIMARY KEY (
       chain, transaction_hash, log_index, block_time, to_classification_version
     ),
     CONSTRAINT rh_wallet_transfer_reclassifications_chain_check CHECK (
       chain = 'robinhood'
     ),
     CONSTRAINT rh_wallet_transfer_reclassifications_position_check CHECK (
       block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
     ),
     CONSTRAINT rh_wallet_transfer_reclassifications_hash_check CHECK (
       transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND block_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_wallet_transfer_reclassifications_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
       AND from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_wallet_transfer_reclassifications_transition_check CHECK (
       amount_raw >= 0
       AND from_transfer_kind = 'unknown'
       AND to_transfer_kind IN (
         'mint', 'burn', 'dex_flow', 'liquidity_flow',
         'router_flow', 'wallet_transfer', 'contract_flow'
       )
       AND from_classification_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND to_classification_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND transition_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND decision_reason ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_wallet_transfer_reclassifications_evidence_check CHECK (
       JSONB_TYPEOF(decision_evidence) = 'object'
       AND decision_evidence <> '{}'::jsonb
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_reclassifications_token
     ON robinhood_wallet_transfer_reclassifications(
       chain, to_classification_version, token_address, applied_at DESC
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 136 Robinhood wallet transfer reclassification ledger created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 136:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
