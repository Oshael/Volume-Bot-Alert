/**
 * Stage 90 - Durable Robinhood wallet-attributed swaps (foundation).
 * Creates the partitioned parent table that stores one economic swap action per
 * (transaction, action) attributed to the signing EOA (tx.from). This is the
 * foundation for wallet tracking and the AXION-style swap feed.
 *
 * Scope of this stage: the PARENT table, its identity, checks and lookup
 * indexes only. It does NOT create daily partitions and does NOT enable any
 * writer; partition management and retention drop belong to later stages.
 *
 * Design notes:
 * - block_time is the daily partition key (RANGE). PostgreSQL requires the
 *   partition key inside any PRIMARY KEY/UNIQUE, so the natural swap identity
 *   (chain, transaction_hash, action_index) is extended with block_time. The
 *   wallet is functionally determined by the action, so this key is a stricter
 *   dedup than the conceptual UNIQUE in the retention plan and needs no wallet
 *   column in the key.
 * - wallet_address is the signing EOA (tx.from), normalized lowercase and
 *   mandatory, so a wallet added to tracking later can still be reconstructed.
 * - derived decimals use unconstrained NUMERIC to avoid EVM precision loss,
 *   mirroring robinhood_market_observations.
 *
 * Run with: node src/utils/db-init-stage90.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_swaps (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     wallet_address VARCHAR(42) NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     action_index BIGINT NOT NULL,
     block_number BIGINT NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     quote_address VARCHAR(42) NOT NULL,
     side VARCHAR(4) NOT NULL,
     token_amount_raw NUMERIC(78, 0) NOT NULL,
     quote_amount_raw NUMERIC(78, 0) NOT NULL,
     token_decimals SMALLINT,
     quote_decimals SMALLINT,
     token_amount NUMERIC,
     quote_amount NUMERIC,
     price_usd NUMERIC,
     volume_usd NUMERIC,
     router_address VARCHAR(42),
     recipient_address VARCHAR(42),
     parser_version VARCHAR(64) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_wallet_swaps_pkey
       PRIMARY KEY (chain, transaction_hash, action_index, block_time),
     CONSTRAINT robinhood_wallet_swaps_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_wallet_swaps_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_wallet_swaps_side_check CHECK (side IN ('buy', 'sell')),
     CONSTRAINT robinhood_wallet_swaps_wallet_check
       CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT robinhood_wallet_swaps_action_index_check CHECK (action_index >= 0),
     CONSTRAINT robinhood_wallet_swaps_block_number_check CHECK (block_number >= 0),
     CONSTRAINT robinhood_wallet_swaps_decimals_check CHECK (
       (token_decimals IS NULL OR token_decimals BETWEEN 0 AND 255)
       AND (quote_decimals IS NULL OR quote_decimals BETWEEN 0 AND 255)
     ),
     CONSTRAINT robinhood_wallet_swaps_amounts_check CHECK (
       token_amount_raw > 0 AND quote_amount_raw > 0
     ),
     CONSTRAINT robinhood_wallet_swaps_parser_version_check
       CHECK (parser_version <> '')
   ) PARTITION BY RANGE (block_time)`,

  `CREATE INDEX IF NOT EXISTS idx_robinhood_wallet_swaps_wallet_time
     ON robinhood_wallet_swaps(chain, wallet_address, block_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_wallet_swaps_token_time
     ON robinhood_wallet_swaps(chain, token_address, block_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_wallet_swaps_chain_time
     ON robinhood_wallet_swaps(chain, block_time DESC)`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 90 durable Robinhood wallet swaps table created successfully');
  } catch (error) {
    console.error('Failed to create stage 90 Robinhood wallet swaps table:', error.message);
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
