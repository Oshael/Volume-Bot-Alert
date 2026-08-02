/** Stage 101 - Materialized Uniswap V4 liquidity by pool and tick range. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_ranges (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     pool_id VARCHAR(66) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     tick_lower INTEGER NOT NULL,
     tick_upper INTEGER NOT NULL,
     liquidity_gross NUMERIC(78, 0) NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_v4_liquidity_ranges_pkey
       PRIMARY KEY (chain, pool_id, tick_lower, tick_upper),
     CONSTRAINT robinhood_v4_liquidity_ranges_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_v4_liquidity_ranges_tick_check CHECK (tick_lower < tick_upper),
     CONSTRAINT robinhood_v4_liquidity_ranges_liquidity_check CHECK (liquidity_gross >= 0)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_v4_liquidity_ranges_market
     ON robinhood_v4_liquidity_ranges(chain, market_key)
     WHERE liquidity_gross > 0`,
  `CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_materialization_state (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     replay_start_block BIGINT NOT NULL,
     replay_target_block BIGINT NOT NULL,
     replay_checkpoint_hash VARCHAR(66) NOT NULL,
     materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     version BIGINT NOT NULL DEFAULT 1,
     CONSTRAINT robinhood_v4_liquidity_materialization_state_pkey PRIMARY KEY (chain),
     CONSTRAINT robinhood_v4_liquidity_materialization_state_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_v4_liquidity_materialization_state_bounds_check
       CHECK (replay_start_block >= 0 AND replay_target_block >= replay_start_block),
     CONSTRAINT robinhood_v4_liquidity_materialization_state_version_check CHECK (version > 0)
   )`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 101 Robinhood V4 liquidity ranges created successfully');
  } catch (error) {
    console.error('Failed to create Stage 101 Robinhood V4 liquidity ranges:', error.message);
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
