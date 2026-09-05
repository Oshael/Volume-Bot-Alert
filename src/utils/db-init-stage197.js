'use strict';

/** Stage 197 - durable, coalescing refresh queue for canonical liquidity events. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_pool_liquidity_refresh_queue (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     dirty_from_block BIGINT NOT NULL,
     dirty_through_block BIGINT NOT NULL,
     dirty_through_hash VARCHAR(66) NOT NULL,
     generation BIGINT NOT NULL DEFAULT 1,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     lease_owner VARCHAR(160),
     lease_until TIMESTAMPTZ,
     last_error JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_pool_liquidity_refresh_queue_pkey
       PRIMARY KEY (chain, protocol, market_key),
     CONSTRAINT rh_pool_liquidity_refresh_queue_pool_fkey
       FOREIGN KEY (chain, protocol, market_key)
       REFERENCES robinhood_pool_registry(chain, protocol, market_key) ON DELETE CASCADE,
     CONSTRAINT rh_pool_liquidity_refresh_queue_values_check CHECK (
       chain = 'robinhood'
       AND protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
       AND dirty_from_block >= 0 AND dirty_through_block >= dirty_from_block
       AND dirty_through_hash ~ '^0x[0-9a-f]{64}$'
       AND generation >= 1 AND attempt_count >= 0
       AND jsonb_typeof(COALESCE(last_error, '{}'::jsonb)) = 'object'
     ),
     CONSTRAINT rh_pool_liquidity_refresh_queue_lifecycle_check CHECK (
       (status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL)
       OR (status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_pool_liquidity_refresh_queue_claim
     ON robinhood_pool_liquidity_refresh_queue(
       next_attempt_at, dirty_from_block, protocol, market_key
     ) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_pool_liquidity_refresh_queue_lease
     ON robinhood_pool_liquidity_refresh_queue(lease_until) WHERE status = 'leased'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 197 Robinhood liquidity refresh queue created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 197:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
