/**
 * Stage 104 - Durable Robinhood derived live-emit outbox (Corte 5).
 * robinhood-processing commits one row per changed live bucket, inside the same
 * transaction as its observation/bucket write, so a robinhood-derived consumer
 * can replay the market:bucket fan-out (socket push, realtime alerts, live
 * catalog, aggregates) without the ingestion monolith. At-least-once: a row
 * survives a consumer crash and is drained on recovery; delete-on-complete keeps
 * the queue self-pruning. The payload is the fully built market:bucket event, so
 * the consumer only fans out — it never rebuilds valuation.
 * Run with: node src/utils/db-init-stage104.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_derived_outbox (
     id BIGSERIAL,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     bucket_ts TIMESTAMPTZ NOT NULL,
     last_block_number BIGINT NOT NULL,
     last_log_index BIGINT NOT NULL,
     payload JSONB NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_derived_outbox_pkey PRIMARY KEY (id),
     CONSTRAINT robinhood_derived_outbox_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_derived_outbox_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_derived_outbox_status_check
       CHECK (status IN ('pending', 'leased', 'blocked')),
     CONSTRAINT robinhood_derived_outbox_block_check
       CHECK (last_block_number >= 0),
     CONSTRAINT robinhood_derived_outbox_log_index_check
       CHECK (last_log_index >= 0),
     CONSTRAINT robinhood_derived_outbox_attempt_check
       CHECK (attempt_count >= 0),
     CONSTRAINT robinhood_derived_outbox_lease_check
       CHECK (
         (status = 'leased')
         = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       ),
     CONSTRAINT robinhood_derived_outbox_payload_check
       CHECK (jsonb_typeof(payload) = 'object')
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_derived_outbox_claim
     ON robinhood_derived_outbox(next_attempt_at, id)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_derived_outbox_lease
     ON robinhood_derived_outbox(lease_until)
     WHERE status = 'leased'`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 104 Robinhood derived outbox created successfully');
  } catch (error) {
    console.error('Failed to create Stage 104 Robinhood derived outbox:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init };
