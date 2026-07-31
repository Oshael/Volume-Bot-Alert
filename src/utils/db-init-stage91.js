/**
 * Stage 91 - Robinhood wallet-swap attribution cursors.
 * Independent progress watermarks for the wallet-attribution work, so seed and
 * live runs resume without rescanning blocks or joining the 71M observations.
 * Mirrors robinhood_ingestion_cursors; it does not enable any writer.
 * Run with: node src/utils/db-init-stage91.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_swap_cursors (
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
     CONSTRAINT robinhood_wallet_swap_cursors_pkey PRIMARY KEY (chain, stream),
     CONSTRAINT robinhood_wallet_swap_cursors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_wallet_swap_cursors_stream_check
       CHECK (stream IN ('seed', 'live')),
     CONSTRAINT robinhood_wallet_swap_cursors_next_block_check CHECK (next_block >= 0),
     CONSTRAINT robinhood_wallet_swap_cursors_safe_head_check
       CHECK (safe_head IS NULL OR safe_head >= 0),
     CONSTRAINT robinhood_wallet_swap_cursors_checkpoint_pair_check
       CHECK ((checkpoint_block IS NULL) = (checkpoint_hash IS NULL))
   )`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 91 Robinhood wallet-swap cursors created successfully');
  } catch (error) {
    console.error('Failed to create stage 91 Robinhood wallet-swap cursors:', error.message);
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
