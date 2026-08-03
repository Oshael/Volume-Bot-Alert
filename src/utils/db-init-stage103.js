/** Stage 103 - Durable Robinhood head capture queue and independent capture cursor. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_head_captures (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     stream VARCHAR(16) NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_index BIGINT NOT NULL,
     address VARCHAR(42) NOT NULL,
     topics JSONB NOT NULL,
     data TEXT NOT NULL,
     protocol VARCHAR(16),
     market_key VARCHAR(160),
     evidence_version INTEGER NOT NULL DEFAULT 1,
     evidence JSONB NOT NULL,
     processing_status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error TEXT,
     terminal_at TIMESTAMPTZ,
     retention_eligible_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_head_captures_pkey
       PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_head_captures_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_head_captures_stream_check
       CHECK (stream IN ('discovery', 'market')),
     CONSTRAINT robinhood_head_captures_block_check
       CHECK (block_number >= 0),
     CONSTRAINT robinhood_head_captures_transaction_index_check
       CHECK (transaction_index >= 0),
     CONSTRAINT robinhood_head_captures_log_index_check
       CHECK (log_index >= 0),
     CONSTRAINT robinhood_head_captures_topics_check
       CHECK (
         jsonb_typeof(topics) = 'array'
         AND jsonb_array_length(topics) > 0
       ),
     CONSTRAINT robinhood_head_captures_evidence_check
       CHECK (jsonb_typeof(evidence) = 'object'),
     CONSTRAINT robinhood_head_captures_evidence_version_check
       CHECK (evidence_version >= 1),
     CONSTRAINT robinhood_head_captures_protocol_check
       CHECK (
         protocol IS NULL
         OR protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
       ),
     CONSTRAINT robinhood_head_captures_status_check
       CHECK (
         processing_status IN ('pending', 'leased', 'processed', 'rejected', 'blocked')
       ),
     CONSTRAINT robinhood_head_captures_attempt_count_check
       CHECK (attempt_count >= 0),
     CONSTRAINT robinhood_head_captures_lease_check
       CHECK (
         (processing_status = 'leased')
         = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       ),
     CONSTRAINT robinhood_head_captures_terminal_check
       CHECK (
         (processing_status IN ('processed', 'rejected'))
         = (terminal_at IS NOT NULL)
       ),
     CONSTRAINT robinhood_head_captures_retention_check
       CHECK (
         retention_eligible_at IS NULL
         OR (
           processing_status IN ('processed', 'rejected')
           AND terminal_at IS NOT NULL
           AND retention_eligible_at > terminal_at
         )
       )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_head_captures_claim
     ON robinhood_head_captures(
       next_attempt_at, block_number, transaction_index, log_index
     )
     WHERE processing_status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_head_captures_lease
     ON robinhood_head_captures(lease_until)
     WHERE processing_status = 'leased'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_head_captures_reorg
     ON robinhood_head_captures(block_number, block_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_head_captures_retention
     ON robinhood_head_captures(retention_eligible_at)
     WHERE retention_eligible_at IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS robinhood_head_capture_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     stream VARCHAR(16) NOT NULL,
     next_block BIGINT NOT NULL,
     safe_head BIGINT,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     checkpoint_timestamp TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_head_capture_cursors_pkey
       PRIMARY KEY (chain, stream),
     CONSTRAINT robinhood_head_capture_cursors_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_head_capture_cursors_stream_check
       CHECK (stream IN ('discovery', 'market')),
     CONSTRAINT robinhood_head_capture_cursors_next_block_check
       CHECK (next_block >= 0),
     CONSTRAINT robinhood_head_capture_cursors_safe_head_check
       CHECK (safe_head IS NULL OR safe_head >= 0),
     CONSTRAINT robinhood_head_capture_cursors_checkpoint_block_check
       CHECK (checkpoint_block IS NULL OR checkpoint_block >= 0),
     CONSTRAINT robinhood_head_capture_cursors_checkpoint_pair_check
       CHECK ((checkpoint_block IS NULL) = (checkpoint_hash IS NULL))
   )`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 103 Robinhood head capture queue created successfully');
  } catch (error) {
    console.error('Failed to create Stage 103 Robinhood head capture queue:', error.message);
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
