/**
 * Stage 66 - Permanent Robinhood one-hour market buckets.
 * Closed and active hours are rebuilt from persistent one-minute buckets.
 * Run with: node src/utils/db-init-stage66.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_market_buckets_1h (
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
     source_minute_buckets SMALLINT NOT NULL,
     first_observed_at TIMESTAMPTZ NOT NULL,
     first_block_number BIGINT NOT NULL,
     first_log_index BIGINT NOT NULL,
     last_observed_at TIMESTAMPTZ NOT NULL,
     last_block_number BIGINT NOT NULL,
     last_log_index BIGINT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_market_buckets_1h_pkey
       PRIMARY KEY (chain, protocol, market_key, bucket_ts),
     CONSTRAINT robinhood_market_buckets_1h_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_market_buckets_1h_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_market_buckets_1h_bucket_check CHECK (
       bucket_ts = date_trunc('hour', bucket_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     ),
     CONSTRAINT robinhood_market_buckets_1h_prices_check CHECK (
       open_price_usd > 0 AND high_price_usd > 0
       AND low_price_usd > 0 AND close_price_usd > 0
       AND high_price_usd >= low_price_usd
     ),
     CONSTRAINT robinhood_market_buckets_1h_fdv_check CHECK (
       open_fdv_usd >= 0 AND high_fdv_usd >= 0
       AND low_fdv_usd >= 0 AND close_fdv_usd >= 0
       AND high_fdv_usd >= low_fdv_usd
     ),
     CONSTRAINT robinhood_market_buckets_1h_activity_check CHECK (
       volume_usd >= 0 AND swaps > 0 AND buys >= 0 AND sells >= 0
       AND buys + sells = swaps AND transactions > 0 AND transactions <= swaps
       AND source_minute_buckets BETWEEN 1 AND 60
     ),
     CONSTRAINT robinhood_market_buckets_1h_order_check CHECK (
       first_observed_at <= last_observed_at
       AND (first_block_number, first_log_index) <= (last_block_number, last_log_index)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_buckets_1h_token_time
     ON robinhood_market_buckets_1h(chain, token_address, bucket_ts DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 66 permanent Robinhood one-hour buckets created successfully');
  } catch (error) {
    console.error('Failed to create stage 66 Robinhood one-hour buckets:', error.message);
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
