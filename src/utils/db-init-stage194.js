'use strict';

/** Stage 194 - isolated evidence sink for the canonical head canary. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_canonical_head_candidates (
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
     evidence_version INTEGER NOT NULL,
     evidence JSONB NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_canonical_head_candidates_pkey PRIMARY KEY (
       chain, transaction_hash, log_index
     ),
     CONSTRAINT rh_canonical_head_candidates_event_fkey FOREIGN KEY (
       chain, block_hash, log_index
     ) REFERENCES robinhood_chain_events(chain, block_hash, log_index) ON DELETE CASCADE,
     CONSTRAINT rh_canonical_head_candidates_values_check CHECK (
       chain = 'robinhood' AND stream IN ('discovery', 'market')
       AND block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
       AND jsonb_typeof(topics) = 'array' AND jsonb_array_length(topics) > 0
       AND jsonb_typeof(evidence) = 'object' AND evidence_version >= 1
       AND (protocol IS NULL OR protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4'))
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_canonical_head_candidates_order
     ON robinhood_canonical_head_candidates(stream, block_number, transaction_index, log_index)`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 194 Robinhood canonical head canary created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 194:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
