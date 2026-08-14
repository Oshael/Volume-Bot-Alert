/** Stage 128 - narrow, daily-partitioned Robinhood ERC-20 transfer evidence. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_token_transfer_events (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     log_index INTEGER NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     from_wallet VARCHAR(42) NOT NULL,
     to_wallet VARCHAR(42) NOT NULL,
     amount_raw NUMERIC(78,0) NOT NULL,
     transfer_kind VARCHAR(32) NOT NULL DEFAULT 'unclassified',
     classification_version VARCHAR(64),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_token_transfer_events_pkey PRIMARY KEY (
       chain, transaction_hash, log_index, block_time
     ),
     CONSTRAINT rh_token_transfer_events_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_token_transfer_events_position_check CHECK (
       block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
     ),
     CONSTRAINT rh_token_transfer_events_hash_check CHECK (
       block_hash ~ '^0x[0-9a-f]{64}$'
       AND transaction_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_token_transfer_events_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
       AND from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_token_transfer_events_amount_check CHECK (amount_raw >= 0),
     CONSTRAINT rh_token_transfer_events_kind_check CHECK (transfer_kind IN (
       'unclassified', 'mint', 'burn', 'dex_flow', 'liquidity_flow',
       'router_flow', 'wallet_transfer', 'contract_flow', 'unknown'
     )),
     CONSTRAINT rh_token_transfer_events_classification_check CHECK (
       (transfer_kind = 'unclassified' AND classification_version IS NULL)
       OR (transfer_kind <> 'unclassified'
         AND classification_version IS NOT NULL
         AND classification_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
     )
   ) PARTITION BY RANGE (block_time)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_token_transfers_token_time
     ON robinhood_token_transfer_events(chain, token_address, block_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_token_transfers_from_time
     ON robinhood_token_transfer_events(chain, from_wallet, block_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_token_transfers_to_time
     ON robinhood_token_transfer_events(chain, to_wallet, block_time DESC)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 128 Robinhood token transfer evidence created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 128:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
