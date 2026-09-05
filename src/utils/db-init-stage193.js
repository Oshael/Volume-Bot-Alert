'use strict';

/** Stage 193 - durable discovery/market fan-out from the canonical journal. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_chain_domain_outbox (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     domain VARCHAR(24) NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_number BIGINT NOT NULL,
     transaction_index INTEGER NOT NULL,
     log_index INTEGER NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     lease_owner VARCHAR(160),
     lease_until TIMESTAMPTZ,
     last_error JSONB,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_domain_outbox_pkey PRIMARY KEY (
       chain, domain, block_hash, log_index
     ),
     CONSTRAINT rh_chain_domain_outbox_event_fkey FOREIGN KEY (
       chain, block_hash, log_index
     ) REFERENCES robinhood_chain_events(chain, block_hash, log_index) ON DELETE CASCADE,
     CONSTRAINT rh_chain_domain_outbox_values_check CHECK (
       chain = 'robinhood' AND domain IN ('discovery', 'market')
       AND block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
       AND attempt_count >= 0
     ),
     CONSTRAINT rh_chain_domain_outbox_lifecycle_check CHECK (
       (status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL AND completed_at IS NULL)
       OR (status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND completed_at IS NULL)
       OR (status = 'complete' AND lease_owner IS NULL AND lease_until IS NULL AND completed_at IS NOT NULL)
       OR (status = 'blocked' AND lease_owner IS NULL AND lease_until IS NULL AND completed_at IS NULL)
     )
   )`,
  `ALTER TABLE robinhood_chain_domain_outbox SET (
     autovacuum_vacuum_scale_factor = 0.005,
     autovacuum_vacuum_threshold = 50000,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_analyze_threshold = 50000
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_chain_domain_outbox_claim
     ON robinhood_chain_domain_outbox(
       domain, status, next_attempt_at, block_number, transaction_index, log_index
     ) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_chain_domain_outbox_lease
     ON robinhood_chain_domain_outbox(domain, lease_until) WHERE status = 'leased'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_chain_domain_outbox_frontier
     ON robinhood_chain_domain_outbox(
       chain, block_number, status, domain, transaction_index, log_index
     ) INCLUDE(next_attempt_at) WHERE status <> 'complete'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 193 Robinhood domain outbox created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 193:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
