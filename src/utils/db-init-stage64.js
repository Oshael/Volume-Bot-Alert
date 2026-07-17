/**
 * Stage 64 - Exact Robinhood market observations.
 * Accepted swaps are retained for three days and cascade with the compact log
 * ledger. Derived decimals use unconstrained NUMERIC to avoid EVM precision loss.
 * Run with: node src/utils/db-init-stage64.js
 */
const db = require('../models/db');

const OBSERVATION_RETENTION_DAYS = 3;
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_market_observations (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     block_number BIGINT NOT NULL,
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     pool_address VARCHAR(42),
     pool_id VARCHAR(66),
     token_address VARCHAR(42) NOT NULL,
     quote_address VARCHAR(42) NOT NULL,
     side VARCHAR(4) NOT NULL,
     status VARCHAR(16) NOT NULL,
     rejection_reason VARCHAR(64),
     observed_at TIMESTAMPTZ NOT NULL,
     token_decimals SMALLINT,
     quote_decimals SMALLINT,
     token_total_supply_raw NUMERIC(78, 0),
     token_amount_raw NUMERIC(78, 0) NOT NULL,
     quote_amount_raw NUMERIC(78, 0) NOT NULL,
     token_amount NUMERIC,
     quote_amount NUMERIC,
     price_quote NUMERIC,
     quote_usd_price NUMERIC,
     price_usd NUMERIC,
     volume_usd NUMERIC,
     fdv_usd NUMERIC,
     market_cap_usd NUMERIC,
     valuation_type VARCHAR(16),
     quote_usd_source VARCHAR(64),
     quote_usd_status VARCHAR(16),
     expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '${OBSERVATION_RETENTION_DAYS} days',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_market_observations_pkey
       PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_market_observations_log_fkey
       FOREIGN KEY (chain, transaction_hash, log_index)
       REFERENCES robinhood_processed_logs(chain, transaction_hash, log_index)
       ON DELETE CASCADE,
     CONSTRAINT robinhood_market_observations_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_market_observations_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_market_observations_side_check CHECK (side IN ('buy', 'sell')),
     CONSTRAINT robinhood_market_observations_status_check
       CHECK (status IN ('pending', 'accepted', 'rejected')),
     CONSTRAINT robinhood_market_observations_pool_identity_check CHECK (
       (protocol = 'uniswap-v4' AND pool_id IS NOT NULL AND pool_address IS NULL)
       OR (protocol <> 'uniswap-v4' AND pool_address IS NOT NULL AND pool_id IS NULL)
     ),
     CONSTRAINT robinhood_market_observations_decimals_check CHECK (
       (token_decimals IS NULL OR token_decimals BETWEEN 0 AND 255)
       AND (quote_decimals IS NULL OR quote_decimals BETWEEN 0 AND 255)
     ),
     CONSTRAINT robinhood_market_observations_amounts_check CHECK (
       token_amount_raw > 0 AND quote_amount_raw > 0
     ),
     CONSTRAINT robinhood_market_observations_accepted_metrics_check CHECK (
       status <> 'accepted' OR (
         token_decimals IS NOT NULL AND quote_decimals IS NOT NULL
         AND token_total_supply_raw IS NOT NULL
         AND token_amount >= 0 AND quote_amount >= 0
         AND price_quote > 0 AND quote_usd_price > 0 AND price_usd > 0
         AND volume_usd >= 0 AND fdv_usd >= 0
         AND valuation_type IS NOT NULL
         AND quote_usd_source IS NOT NULL AND quote_usd_status IS NOT NULL
       )
     ),
     CONSTRAINT robinhood_market_observations_expiry_check CHECK (expires_at > created_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_observations_market_time
     ON robinhood_market_observations(chain, market_key, observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_observations_token_time
     ON robinhood_market_observations(chain, token_address, observed_at DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 64 exact Robinhood market observations created successfully');
  } catch (error) {
    console.error('Failed to create stage 64 Robinhood market observations:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { OBSERVATION_RETENTION_DAYS, STATEMENTS, init };
