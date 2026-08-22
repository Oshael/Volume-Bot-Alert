/** Stage 149 - durable canonical first buy per Robinhood token and wallet. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_token_first_buys (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     action_index BIGINT NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     volume_usd NUMERIC,
     source_parser_version VARCHAR(64) NOT NULL,
     evidence_version VARCHAR(32) NOT NULL DEFAULT 'rh_first_buy_v1',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_token_first_buys_pkey
       PRIMARY KEY (chain, token_address, wallet_address),
     CONSTRAINT rh_wallet_token_first_buys_pool_fkey
       FOREIGN KEY (chain, protocol, market_key)
       REFERENCES robinhood_pool_registry(chain, protocol, market_key),
     CONSTRAINT rh_wallet_token_first_buys_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_wallet_token_first_buys_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
       AND wallet_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_wallet_token_first_buys_hash_check CHECK (
       transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND block_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_wallet_token_first_buys_position_check CHECK (
       transaction_index >= 0 AND action_index >= 0 AND block_number >= 0
     ),
     CONSTRAINT rh_wallet_token_first_buys_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT rh_wallet_token_first_buys_values_check CHECK (
       BTRIM(market_key) <> ''
       AND (volume_usd IS NULL OR volume_usd >= 0)
       AND BTRIM(source_parser_version) <> ''
       AND evidence_version ~ '^rh_first_buy_v[1-9][0-9]*$'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_token_first_buys_token_order
     ON robinhood_wallet_token_first_buys(
       chain, token_address, block_number, transaction_index,
       action_index, transaction_hash
     ) INCLUDE (wallet_address, volume_usd)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_token_first_buys_wallet_recurrence
     ON robinhood_wallet_token_first_buys(
       chain, wallet_address, block_number, token_address
     ) INCLUDE (volume_usd, transaction_index, action_index)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 149 Robinhood wallet-token first buys created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 149:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
