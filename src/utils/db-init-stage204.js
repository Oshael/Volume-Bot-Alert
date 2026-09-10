'use strict';

/** Stage 204 - durable, versioned Robinhood trade publication lifecycle. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_swap_realtime_outbox (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     event_kind VARCHAR(16) NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     payload JSONB NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     published_at TIMESTAMPTZ,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_swap_realtime_outbox_pkey PRIMARY KEY (
       chain, transaction_hash, log_index, event_kind
     ),
     CONSTRAINT rh_wallet_swap_realtime_outbox_identity_check CHECK (
       chain = 'robinhood'
       AND transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND block_hash ~ '^0x[0-9a-f]{64}$'
       AND block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
     ),
     CONSTRAINT rh_wallet_swap_realtime_outbox_event_check CHECK (
       event_kind IN ('observed', 'finalized', 'invalidate')
     ),
     CONSTRAINT rh_wallet_swap_realtime_outbox_status_check CHECK (
       status IN ('pending', 'leased', 'complete', 'blocked')
     ),
     CONSTRAINT rh_wallet_swap_realtime_outbox_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_wallet_swap_realtime_outbox_completion_check CHECK (
       (status = 'complete') = (published_at IS NOT NULL)
     ),
     CONSTRAINT rh_wallet_swap_realtime_outbox_payload_check CHECK (
       jsonb_typeof(payload) = 'object'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_swap_realtime_outbox_claim
     ON robinhood_wallet_swap_realtime_outbox(
       next_attempt_at, event_kind, block_number, transaction_index, log_index
     ) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_swap_realtime_outbox_lease
     ON robinhood_wallet_swap_realtime_outbox(lease_until) WHERE status = 'leased'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_swap_realtime_outbox_canonical
     ON robinhood_wallet_swap_realtime_outbox(block_number, block_hash)
     WHERE event_kind = 'observed' AND status = 'complete'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_swap_realtime_outbox_promote
     ON robinhood_wallet_swap_realtime_outbox(
       block_number, transaction_index, log_index
     ) WHERE event_kind = 'observed'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 204 Robinhood trade lifecycle outbox created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 204:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
