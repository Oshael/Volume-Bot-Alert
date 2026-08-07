/**
 * Stage 109 - Durable per-swap market cap sidecar (robinhood_swap_mc).
 *
 * Per-swap FDV (market cap) and at-block total supply live only on
 * `robinhood_market_observations`, a wide table that is meant to be pruned to
 * reclaim disk. Before pruning, the values worth keeping are copied into this
 * narrow sidecar, keyed exactly like the observation (`log_index` = the wallet
 * swap `action_index`). The trades feed then reads MC from here instead of the
 * wide observation, so old trades keep their market cap after the raw is gone.
 *
 * Populated two ways: forward, alongside each attributed swap insert; and for
 * history, a bulk `INSERT ... SELECT` from the (post-repair) observations. Both
 * are idempotent on the primary key. Not partitioned — it is a flat 1:1 sidecar.
 *
 * Run with: node src/utils/db-init-stage109.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_swap_mc (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     fdv_usd NUMERIC,
     token_total_supply_raw NUMERIC(78, 0),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_swap_mc_pkey PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_swap_mc_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_swap_mc_log_index_check CHECK (log_index >= 0),
     CONSTRAINT robinhood_swap_mc_supply_check CHECK (
       token_total_supply_raw IS NULL OR token_total_supply_raw >= 0
     )
   )`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 109 Robinhood swap MC sidecar created successfully');
  } catch (error) {
    console.error('Failed to create stage 109 Robinhood swap MC sidecar:', error.message);
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
