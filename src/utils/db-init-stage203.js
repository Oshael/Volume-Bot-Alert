'use strict';

/** Stage 203 - durable work queue for canonical wallet-swap attribution. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_swap_outbox (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     payload JSONB NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_swap_outbox_pkey PRIMARY KEY (
       chain, transaction_hash, log_index
     ),
     CONSTRAINT rh_wallet_swap_outbox_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_swap_outbox_identity_check CHECK (
       transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND block_hash ~ '^0x[0-9a-f]{64}$'
       AND block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
     ),
     CONSTRAINT rh_wallet_swap_outbox_status_check CHECK (
       status IN ('pending', 'leased', 'blocked')
     ),
     CONSTRAINT rh_wallet_swap_outbox_attempt_check CHECK (attempt_count >= 0),
     CONSTRAINT rh_wallet_swap_outbox_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_wallet_swap_outbox_payload_check CHECK (
       jsonb_typeof(payload) = 'object'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_swap_outbox_claim
     ON robinhood_wallet_swap_outbox(
       block_number, transaction_index, log_index, next_attempt_at
     ) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_swap_outbox_lease
     ON robinhood_wallet_swap_outbox(lease_until) WHERE status = 'leased'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 203 Robinhood wallet-swap outbox created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 203:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
