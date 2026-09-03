'use strict';

/** Stage 191 - canonical Robinhood block/receipt journal and single capture cursor. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_chain_blocks (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     parent_hash VARCHAR(66) NOT NULL,
     capture_digest VARCHAR(66) NOT NULL,
     block_timestamp TIMESTAMPTZ NOT NULL,
     finality VARCHAR(16) NOT NULL DEFAULT 'observed',
     canonical BOOLEAN NOT NULL DEFAULT TRUE,
     head_observed_at TIMESTAMPTZ NOT NULL,
     receipts_available_at TIMESTAMPTZ NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_blocks_pkey PRIMARY KEY (chain, block_hash),
     CONSTRAINT rh_chain_blocks_identity_check CHECK (
       chain = 'robinhood' AND block_number >= 0
       AND block_hash ~ '^0x[0-9a-f]{64}$'
       AND parent_hash ~ '^0x[0-9a-f]{64}$'
       AND capture_digest ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_chain_blocks_finality_check CHECK (
       finality IN ('observed', 'finalized') AND (finality <> 'finalized' OR canonical)
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_chain_blocks_canonical_number
     ON robinhood_chain_blocks(chain, block_number) WHERE canonical`,
  `CREATE TABLE IF NOT EXISTS robinhood_chain_transactions (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_hash VARCHAR(66) NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     from_address VARCHAR(42) NOT NULL,
     to_address VARCHAR(42),
     receipt_succeeded BOOLEAN NOT NULL,
     contract_address VARCHAR(42),
     CONSTRAINT rh_chain_transactions_pkey PRIMARY KEY (
       chain, block_hash, transaction_hash
     ),
     CONSTRAINT rh_chain_transactions_block_fkey FOREIGN KEY (chain, block_hash)
       REFERENCES robinhood_chain_blocks(chain, block_hash) ON DELETE CASCADE,
     CONSTRAINT rh_chain_transactions_index_key UNIQUE (
       chain, block_hash, transaction_index
     ),
     CONSTRAINT rh_chain_transactions_values_check CHECK (
       transaction_index >= 0 AND from_address ~ '^0x[0-9a-f]{40}$'
       AND (to_address IS NULL OR to_address ~ '^0x[0-9a-f]{40}$')
       AND (contract_address IS NULL OR contract_address ~ '^0x[0-9a-f]{40}$')
     )
   )`,
  `CREATE TABLE IF NOT EXISTS robinhood_chain_events (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_hash VARCHAR(66) NOT NULL,
     block_number BIGINT NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     log_index INTEGER NOT NULL,
     address VARCHAR(42) NOT NULL,
     topic0 VARCHAR(66) NOT NULL,
     topics JSONB NOT NULL,
     data TEXT NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_events_pkey PRIMARY KEY (chain, block_hash, log_index),
     CONSTRAINT rh_chain_events_transaction_fkey FOREIGN KEY (
       chain, block_hash, transaction_hash
     ) REFERENCES robinhood_chain_transactions(chain, block_hash, transaction_hash)
       ON DELETE CASCADE,
     CONSTRAINT rh_chain_events_values_check CHECK (
       block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
       AND address ~ '^0x[0-9a-f]{40}$' AND topic0 ~ '^0x[0-9a-f]{64}$'
       AND jsonb_typeof(topics) = 'array' AND jsonb_array_length(topics) > 0
       AND topics ->> 0 = topic0
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_chain_events_order
     ON robinhood_chain_events(chain, block_number, transaction_index, log_index)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_chain_events_topic
     ON robinhood_chain_events(chain, topic0, block_number)`,
  `CREATE TABLE IF NOT EXISTS robinhood_chain_capture_cursor (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     next_block BIGINT NOT NULL,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     node_head BIGINT,
     finalized_head BIGINT,
     head_observed_at TIMESTAMPTZ,
     receipts_available_at TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_capture_cursor_pkey PRIMARY KEY (chain),
     CONSTRAINT rh_chain_capture_cursor_values_check CHECK (
       chain = 'robinhood' AND next_block >= 0
       AND (checkpoint_block IS NULL) = (checkpoint_hash IS NULL)
       AND (checkpoint_block IS NULL OR (
         checkpoint_block >= 0 AND checkpoint_hash ~ '^0x[0-9a-f]{64}$'
         AND next_block = checkpoint_block + 1
       ))
       AND (node_head IS NULL OR node_head >= checkpoint_block)
       AND (finalized_head IS NULL OR (
         finalized_head >= 0 AND node_head IS NOT NULL AND finalized_head <= node_head
       ))
     )
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 191 canonical Robinhood chain journal created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 191:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
