/**
 * Stage 65 - Persistent Robinhood one-minute market buckets.
 * Accepted observations are folded into OHLCV buckets retained for 14 days.
 * Run with: node src/utils/db-init-stage65.js
 */
const db = require('../models/db');

const BUCKET_RETENTION_DAYS = 14;
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_market_buckets_1m (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     quote_address VARCHAR(42) NOT NULL,
     bucket_ts TIMESTAMPTZ NOT NULL,
     open_price_usd NUMERIC NOT NULL,
     high_price_usd NUMERIC NOT NULL,
     low_price_usd NUMERIC NOT NULL,
     close_price_usd NUMERIC NOT NULL,
     open_fdv_usd NUMERIC NOT NULL,
     high_fdv_usd NUMERIC NOT NULL,
     low_fdv_usd NUMERIC NOT NULL,
     close_fdv_usd NUMERIC NOT NULL,
     volume_usd NUMERIC NOT NULL,
     swaps BIGINT NOT NULL,
     buys BIGINT NOT NULL,
     sells BIGINT NOT NULL,
     transactions BIGINT NOT NULL,
     first_observed_at TIMESTAMPTZ NOT NULL,
     first_block_number BIGINT NOT NULL,
     first_log_index BIGINT NOT NULL,
     last_observed_at TIMESTAMPTZ NOT NULL,
     last_block_number BIGINT NOT NULL,
     last_log_index BIGINT NOT NULL,
     expires_at TIMESTAMPTZ NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_market_buckets_1m_pkey
       PRIMARY KEY (chain, protocol, market_key, bucket_ts),
     CONSTRAINT robinhood_market_buckets_1m_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_market_buckets_1m_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_market_buckets_1m_prices_check CHECK (
       open_price_usd > 0 AND high_price_usd > 0
       AND low_price_usd > 0 AND close_price_usd > 0
       AND high_price_usd >= low_price_usd
     ),
     CONSTRAINT robinhood_market_buckets_1m_fdv_check CHECK (
       open_fdv_usd >= 0 AND high_fdv_usd >= 0
       AND low_fdv_usd >= 0 AND close_fdv_usd >= 0
       AND high_fdv_usd >= low_fdv_usd
     ),
     CONSTRAINT robinhood_market_buckets_1m_activity_check CHECK (
       volume_usd >= 0 AND swaps > 0 AND buys >= 0 AND sells >= 0
       AND buys + sells = swaps AND transactions > 0 AND transactions <= swaps
     ),
     CONSTRAINT robinhood_market_buckets_1m_order_check CHECK (
       first_observed_at <= last_observed_at
       AND (first_block_number, first_log_index) <= (last_block_number, last_log_index)
     ),
     CONSTRAINT robinhood_market_buckets_1m_expiry_check CHECK (expires_at > bucket_ts)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_buckets_1m_token_time
     ON robinhood_market_buckets_1m(chain, token_address, bucket_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_buckets_1m_expiry
     ON robinhood_market_buckets_1m(expires_at)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 65 persistent Robinhood one-minute buckets created successfully');
  } catch (error) {
    console.error('Failed to create stage 65 Robinhood one-minute buckets:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { BUCKET_RETENTION_DAYS, STATEMENTS, init };
