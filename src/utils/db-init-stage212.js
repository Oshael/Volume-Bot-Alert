'use strict';

/** Stage 212 - durable token-level signals for Robinhood liquidity realtime. */
const db = require('../models/db');
const { NOTIFY_CHANNEL, TABLE } = require('../models/robinhood-liquidity-realtime-outbox');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     id BIGSERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     snapshot_block_number BIGINT NOT NULL,
     snapshot_block_hash VARCHAR(66) NOT NULL,
     projection_committed_at TIMESTAMPTZ NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_liquidity_realtime_outbox_source_key
       UNIQUE (chain, protocol, market_key, snapshot_block_number, snapshot_block_hash),
     CONSTRAINT robinhood_liquidity_realtime_outbox_pool_fkey
       FOREIGN KEY (chain, protocol, market_key)
       REFERENCES robinhood_pool_registry(chain, protocol, market_key) ON DELETE CASCADE,
     CONSTRAINT robinhood_liquidity_realtime_outbox_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_liquidity_realtime_outbox_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_liquidity_realtime_outbox_block_check
       CHECK (snapshot_block_number >= 0 AND snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
     CONSTRAINT robinhood_liquidity_realtime_outbox_status_check
       CHECK (status IN ('pending', 'leased', 'complete', 'blocked') AND attempt_count >= 0),
     CONSTRAINT robinhood_liquidity_realtime_outbox_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_liquidity_realtime_outbox_claim
     ON ${TABLE}(next_attempt_at, id) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_liquidity_realtime_outbox_lease
     ON ${TABLE}(lease_until) WHERE status = 'leased'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 212 Robinhood liquidity realtime outbox created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 212:', error.message);
  process.exitCode = 1;
});

module.exports = { NOTIFY_CHANNEL, STATEMENTS, TABLE, init };
