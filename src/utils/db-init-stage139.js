/** Stage 139 - canonical Robinhood transaction positions for swap ordering. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_transaction_positions (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_transaction_positions_pkey
       PRIMARY KEY (chain, transaction_hash),
     CONSTRAINT robinhood_transaction_positions_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_transaction_positions_tx_hash_check
       CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
     CONSTRAINT robinhood_transaction_positions_block_hash_check
       CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
     CONSTRAINT robinhood_transaction_positions_block_check CHECK (block_number >= 0),
     CONSTRAINT robinhood_transaction_positions_index_check CHECK (transaction_index >= 0)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_transaction_positions_block
     ON robinhood_transaction_positions(chain, block_number, transaction_index)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 139 Robinhood transaction positions created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 139:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
