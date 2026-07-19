/**
 * Stage 78 - Token-level Robinhood aggregate market buckets.
 * Run with: node src/utils/db-init-stage78.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_market_buckets_agg (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     granularity_minutes SMALLINT NOT NULL,
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
     market_count INTEGER NOT NULL,
     protocols TEXT[] NOT NULL,
     source_granularity_minutes SMALLINT NOT NULL,
     source_bucket_count INTEGER NOT NULL,
     first_observed_at TIMESTAMPTZ NOT NULL,
     first_block_number BIGINT NOT NULL,
     first_log_index BIGINT NOT NULL,
     last_observed_at TIMESTAMPTZ NOT NULL,
     last_block_number BIGINT NOT NULL,
     last_log_index BIGINT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_market_buckets_agg_pkey
       PRIMARY KEY (chain, token_address, granularity_minutes, bucket_ts),
     CONSTRAINT robinhood_market_buckets_agg_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_market_buckets_agg_granularity_check CHECK (
       granularity_minutes IN (5, 15, 30, 60, 240, 1440)
       AND source_granularity_minutes IN (1, 60)
       AND MOD(EXTRACT(EPOCH FROM bucket_ts)::bigint, granularity_minutes * 60) = 0
     ),
     CONSTRAINT robinhood_market_buckets_agg_values_check CHECK (
       open_price_usd > 0 AND close_price_usd > 0
       AND low_price_usd > 0
       AND high_price_usd >= GREATEST(open_price_usd, close_price_usd)
       AND low_price_usd <= LEAST(open_price_usd, close_price_usd)
       AND open_fdv_usd >= 0 AND close_fdv_usd >= 0 AND low_fdv_usd >= 0
       AND high_fdv_usd >= GREATEST(open_fdv_usd, close_fdv_usd)
       AND low_fdv_usd <= LEAST(open_fdv_usd, close_fdv_usd)
     ),
     CONSTRAINT robinhood_market_buckets_agg_activity_check CHECK (
       volume_usd >= 0 AND swaps > 0 AND buys >= 0 AND sells >= 0
       AND buys + sells = swaps AND transactions > 0 AND transactions <= swaps
       AND market_count > 0 AND source_bucket_count > 0
     ),
     CONSTRAINT robinhood_market_buckets_agg_protocols_check CHECK (
       cardinality(protocols) BETWEEN 1 AND 3
       AND protocols <@ ARRAY['uniswap-v2', 'uniswap-v3', 'uniswap-v4']::TEXT[]
     ),
     CONSTRAINT robinhood_market_buckets_agg_order_check CHECK (
       first_observed_at <= last_observed_at
       AND (first_block_number, first_log_index) <= (last_block_number, last_log_index)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_buckets_agg_token_range
     ON robinhood_market_buckets_agg(chain, token_address, granularity_minutes, bucket_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_market_buckets_agg_cleanup
     ON robinhood_market_buckets_agg(granularity_minutes, bucket_ts)`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 78 Robinhood aggregate buckets created successfully');
  } catch (error) {
    console.error('Failed to create stage 78 Robinhood aggregate buckets:', error.message);
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
