/**
 * Stage 99 - Immutable Uniswap V4 ModifyLiquidity ledger.
 * Range balances are intentionally materialized only after historical coverage.
 * Run with: node src/utils/db-init-stage99.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_deltas (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     pool_id VARCHAR(66) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     sender VARCHAR(42) NOT NULL,
     tick_lower INTEGER NOT NULL,
     tick_upper INTEGER NOT NULL,
     liquidity_delta NUMERIC(78, 0) NOT NULL,
     salt VARCHAR(66) NOT NULL,
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_v4_liquidity_deltas_pkey
       PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_v4_liquidity_deltas_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_v4_liquidity_deltas_block_check
       CHECK (block_number >= 0 AND log_index >= 0),
     CONSTRAINT robinhood_v4_liquidity_deltas_tick_check
       CHECK (tick_lower < tick_upper)
   )`,
  `ALTER TABLE robinhood_v4_liquidity_deltas
     DROP CONSTRAINT IF EXISTS robinhood_v4_liquidity_deltas_log_fkey`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_v4_liquidity_deltas_pool_range
     ON robinhood_v4_liquidity_deltas(
       chain, pool_id, tick_lower, tick_upper, block_number, log_index
     )`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 99 Robinhood V4 liquidity ledger created successfully');
  } catch (error) {
    console.error('Failed to create Stage 99 Robinhood V4 liquidity ledger:', error.message);
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
