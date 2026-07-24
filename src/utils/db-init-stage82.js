/**
 * Stage 82 - Durable Robinhood backfill capture.
 * Creates range manifests, raw market-log staging and independent watermarks.
 * It does not enable the scanner or enrichment workers.
 * Run with: node src/utils/db-init-stage82.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_backfill_ranges (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     stream VARCHAR(16) NOT NULL,
     from_block BIGINT NOT NULL,
     to_block BIGINT NOT NULL,
     provider VARCHAR(64),
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     raw_log_count INTEGER NOT NULL DEFAULT 0,
     tracked_log_count INTEGER NOT NULL DEFAULT 0,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     checkpoint_timestamp TIMESTAMPTZ,
     decoder_version VARCHAR(64) NOT NULL,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error TEXT,
     fetch_started_at TIMESTAMPTZ,
     fetch_finished_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_backfill_ranges_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_backfill_ranges_stream_check
       CHECK (stream IN ('discovery', 'market')),
     CONSTRAINT robinhood_backfill_ranges_status_check
       CHECK (status IN ('pending', 'fetching', 'captured', 'failed', 'blocked')),
     CONSTRAINT robinhood_backfill_ranges_bounds_check
       CHECK (from_block >= 0 AND to_block >= from_block),
     CONSTRAINT robinhood_backfill_ranges_counts_check
       CHECK (
         raw_log_count >= 0
         AND tracked_log_count >= 0
         AND tracked_log_count <= raw_log_count
       ),
     CONSTRAINT robinhood_backfill_ranges_attempt_count_check
       CHECK (attempt_count >= 0),
     CONSTRAINT robinhood_backfill_ranges_decoder_version_check
       CHECK (decoder_version <> ''),
     CONSTRAINT robinhood_backfill_ranges_checkpoint_pair_check
       CHECK ((checkpoint_block IS NULL) = (checkpoint_hash IS NULL)),
     CONSTRAINT robinhood_backfill_ranges_checkpoint_bounds_check
       CHECK (
         checkpoint_block IS NULL
         OR checkpoint_block BETWEEN from_block AND to_block
       ),
     CONSTRAINT robinhood_backfill_ranges_fetch_timing_check
       CHECK (
         fetch_finished_at IS NULL
         OR (
           fetch_started_at IS NOT NULL
           AND fetch_finished_at >= fetch_started_at
         )
       ),
     CONSTRAINT robinhood_backfill_ranges_completion_check
       CHECK (
         (
           status = 'captured'
           AND completed_at IS NOT NULL
           AND checkpoint_block = to_block
         )
         OR (
           status <> 'captured'
           AND completed_at IS NULL
         )
       ),
     CONSTRAINT robinhood_backfill_ranges_identity_key
       UNIQUE (chain, stream, from_block, to_block)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_backfill_ranges_commit
     ON robinhood_backfill_ranges(chain, stream, from_block, to_block)
     WHERE status = 'captured'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_backfill_ranges_retry
     ON robinhood_backfill_ranges(chain, stream, next_attempt_at, from_block)
     WHERE status IN ('pending', 'failed')`,

  `CREATE TABLE IF NOT EXISTS robinhood_market_log_staging (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     range_id BIGINT NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_index BIGINT NOT NULL,
     address VARCHAR(42) NOT NULL,
     topics JSONB NOT NULL,
     data TEXT NOT NULL,
     protocol VARCHAR(16),
     market_key VARCHAR(160),
     enrichment_status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error TEXT,
     terminal_at TIMESTAMPTZ,
     retention_eligible_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_market_log_staging_pkey
       PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_market_log_staging_range_fkey
       FOREIGN KEY (range_id) REFERENCES robinhood_backfill_ranges(id)
       ON DELETE RESTRICT,
     CONSTRAINT robinhood_market_log_staging_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_market_log_staging_block_check
       CHECK (block_number >= 0),
     CONSTRAINT robinhood_market_log_staging_transaction_index_check
       CHECK (transaction_index >= 0),
     CONSTRAINT robinhood_market_log_staging_log_index_check
       CHECK (log_index >= 0),
     CONSTRAINT robinhood_market_log_staging_topics_check
       CHECK (
         jsonb_typeof(topics) = 'array'
         AND jsonb_array_length(topics) > 0
       ),
     CONSTRAINT robinhood_market_log_staging_protocol_check
       CHECK (
         protocol IS NULL
         OR protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
       ),
     CONSTRAINT robinhood_market_log_staging_status_check
       CHECK (
         enrichment_status IN ('pending', 'leased', 'completed', 'rejected', 'blocked')
       ),
     CONSTRAINT robinhood_market_log_staging_attempt_count_check
       CHECK (attempt_count >= 0),
     CONSTRAINT robinhood_market_log_staging_lease_check
       CHECK (
         (enrichment_status = 'leased')
         = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       ),
     CONSTRAINT robinhood_market_log_staging_terminal_check
       CHECK (
         (enrichment_status IN ('completed', 'rejected'))
         = (terminal_at IS NOT NULL)
       ),
     CONSTRAINT robinhood_market_log_staging_retention_check
       CHECK (
         retention_eligible_at IS NULL
         OR (
           enrichment_status IN ('completed', 'rejected')
           AND terminal_at IS NOT NULL
           AND retention_eligible_at > terminal_at
         )
       )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_log_staging_claim
     ON robinhood_market_log_staging(
       next_attempt_at, block_number, transaction_index, log_index
     )
     WHERE enrichment_status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_log_staging_lease
     ON robinhood_market_log_staging(lease_until)
     WHERE enrichment_status = 'leased'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_log_staging_range
     ON robinhood_market_log_staging(range_id, enrichment_status)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_log_staging_retention
     ON robinhood_market_log_staging(retention_eligible_at)
     WHERE retention_eligible_at IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS robinhood_backfill_watermarks (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     frontier VARCHAR(32) NOT NULL,
     next_block BIGINT NOT NULL,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     checkpoint_timestamp TIMESTAMPTZ,
     last_range_id BIGINT,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_backfill_watermarks_pkey
       PRIMARY KEY (chain, frontier),
     CONSTRAINT robinhood_backfill_watermarks_range_fkey
       FOREIGN KEY (last_range_id) REFERENCES robinhood_backfill_ranges(id)
       ON DELETE RESTRICT,
     CONSTRAINT robinhood_backfill_watermarks_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_backfill_watermarks_frontier_check
       CHECK (frontier IN ('discovery_scan', 'market_scan', 'market_enriched')),
     CONSTRAINT robinhood_backfill_watermarks_next_block_check
       CHECK (next_block >= 0),
     CONSTRAINT robinhood_backfill_watermarks_checkpoint_block_check
       CHECK (checkpoint_block IS NULL OR checkpoint_block >= 0),
     CONSTRAINT robinhood_backfill_watermarks_checkpoint_pair_check
       CHECK ((checkpoint_block IS NULL) = (checkpoint_hash IS NULL)),
     CONSTRAINT robinhood_backfill_watermarks_checkpoint_boundary_check
       CHECK (checkpoint_block IS NULL OR checkpoint_block < next_block),
     CONSTRAINT robinhood_backfill_watermarks_version_check
       CHECK (version >= 0)
   )`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 82 durable Robinhood backfill capture created successfully');
  } catch (error) {
    console.error('Failed to create Stage 82 durable Robinhood backfill capture:', error.message);
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
