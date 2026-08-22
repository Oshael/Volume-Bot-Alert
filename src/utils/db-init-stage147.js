/** Stage 147 - Canonical current Robinhood liquidity snapshot per active pool. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_pool_liquidity_snapshots (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     snapshot_block_number BIGINT,
     snapshot_block_hash VARCHAR(66),
     snapshot_observed_at TIMESTAMPTZ,
     liquidity_usd NUMERIC,
     liquidity_raw NUMERIC,
     liquidity_status VARCHAR(64),
     liquidity_confidence VARCHAR(16),
     liquidity_warning VARCHAR(64),
     checked_at TIMESTAMPTZ NOT NULL,
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_pool_liquidity_snapshots_pkey
       PRIMARY KEY (chain, protocol, market_key),
     CONSTRAINT robinhood_pool_liquidity_snapshots_pool_fkey
       FOREIGN KEY (chain, protocol, market_key)
       REFERENCES robinhood_pool_registry(chain, protocol, market_key)
       ON DELETE CASCADE,
     CONSTRAINT robinhood_pool_liquidity_snapshots_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_pool_liquidity_snapshots_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_pool_liquidity_snapshots_snapshot_check CHECK (
       (snapshot_block_number IS NULL
         AND snapshot_block_hash IS NULL AND snapshot_observed_at IS NULL
         AND liquidity_usd IS NULL AND liquidity_raw IS NULL
         AND liquidity_status IS NULL AND liquidity_confidence IS NULL
         AND liquidity_warning IS NULL)
       OR (snapshot_block_number >= 0
         AND snapshot_block_hash ~ '^0x[0-9a-f]{64}$'
         AND snapshot_observed_at IS NOT NULL
         AND (liquidity_usd IS NULL OR liquidity_usd >= 0)
         AND (liquidity_raw IS NULL OR liquidity_raw >= 0)
         AND liquidity_status IN (
           'spot_estimate_from_double_quote_reserve',
           'missing_v2_reserve_or_quote',
           'spot_tvl_from_pool_balances',
           'spot_tvl_from_v4_tick_ranges',
           'requires_tick_liquidity_distribution'
         )
         AND liquidity_confidence IN ('none', 'medium'))
     ),
     CONSTRAINT robinhood_pool_liquidity_snapshots_protocol_metrics_check CHECK (
       snapshot_block_number IS NULL
       OR (protocol = 'uniswap-v2' AND liquidity_raw IS NULL AND (
         (liquidity_status = 'spot_estimate_from_double_quote_reserve'
           AND liquidity_usd IS NOT NULL AND liquidity_confidence = 'medium')
         OR (liquidity_status = 'missing_v2_reserve_or_quote'
           AND liquidity_usd IS NULL AND liquidity_confidence = 'none')
       ))
       OR (protocol = 'uniswap-v3' AND liquidity_raw IS NOT NULL AND (
         (liquidity_status = 'spot_tvl_from_pool_balances'
           AND liquidity_usd IS NOT NULL AND liquidity_confidence = 'medium')
         OR (liquidity_status = 'requires_tick_liquidity_distribution'
           AND liquidity_usd IS NULL AND liquidity_confidence = 'none')
       ))
       OR (protocol = 'uniswap-v4' AND liquidity_raw IS NOT NULL AND (
         (liquidity_status = 'spot_tvl_from_v4_tick_ranges'
           AND liquidity_usd IS NOT NULL AND liquidity_confidence = 'medium')
         OR (liquidity_status = 'requires_tick_liquidity_distribution'
           AND liquidity_usd IS NULL AND liquidity_confidence = 'none')
       ))
     ),
     CONSTRAINT robinhood_pool_liquidity_snapshots_error_check CHECK (
       (consecutive_failures = 0
         AND last_error_code IS NULL AND last_error_message IS NULL)
       OR (consecutive_failures > 0
         AND last_error_code ~ '^[a-z0-9][a-z0-9_:-]{0,63}$'
         AND last_error_message IS NOT NULL AND BTRIM(last_error_message) <> '')
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_pool_liquidity_snapshots_due
     ON robinhood_pool_liquidity_snapshots(chain, checked_at, market_key)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 147 Robinhood pool liquidity snapshots created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 147:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
