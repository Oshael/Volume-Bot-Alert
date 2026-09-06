/**
 * Stage 83 - Durable Robinhood backfill aggregation outbox.
 * Historical enrichment publishes one aggregation target per accepted
 * observation without entering the live socket/alert path.
 * Run with: node src/utils/db-init-stage83.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_backfill_aggregation_outbox (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     bucket_ts TIMESTAMPTZ NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error TEXT,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_backfill_aggregation_outbox_pkey
       PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_backfill_aggregation_outbox_observation_fkey
       FOREIGN KEY (chain, transaction_hash, log_index)
       REFERENCES robinhood_market_observations(chain, transaction_hash, log_index)
       ON DELETE CASCADE,
     CONSTRAINT robinhood_backfill_aggregation_outbox_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_backfill_aggregation_outbox_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_backfill_aggregation_outbox_status_check
       CHECK (status IN ('pending', 'leased', 'completed', 'blocked')),
     CONSTRAINT robinhood_backfill_aggregation_outbox_attempt_check
       CHECK (attempt_count >= 0),
     CONSTRAINT robinhood_backfill_aggregation_outbox_lease_check
       CHECK (
         (status = 'leased')
         = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       ),
     CONSTRAINT robinhood_backfill_aggregation_outbox_completion_check
       CHECK ((status = 'completed') = (completed_at IS NOT NULL))
   )`,
  `ALTER TABLE robinhood_backfill_aggregation_outbox
     DROP CONSTRAINT IF EXISTS robinhood_backfill_aggregation_outbox_observation_fkey`,
  `ALTER TABLE robinhood_backfill_aggregation_outbox
     ADD CONSTRAINT robinhood_backfill_aggregation_outbox_observation_fkey
     FOREIGN KEY (chain, transaction_hash, log_index)
     REFERENCES robinhood_market_observations(chain, transaction_hash, log_index)
     ON DELETE CASCADE NOT VALID`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_backfill_aggregation_outbox_claim
     ON robinhood_backfill_aggregation_outbox(
       next_attempt_at, bucket_ts, transaction_hash, log_index
     )
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_backfill_aggregation_outbox_bucket
     ON robinhood_backfill_aggregation_outbox(
       chain, protocol, market_key, bucket_ts
     )
     WHERE status <> 'completed'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_backfill_aggregation_outbox_lease
     ON robinhood_backfill_aggregation_outbox(lease_until)
     WHERE status = 'leased'`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 83 Robinhood backfill aggregation outbox created successfully');
  } catch (error) {
    console.error('Failed to create Stage 83 Robinhood aggregation outbox:', error.message);
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
