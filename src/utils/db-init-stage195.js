'use strict';

/** Stage 195 - exact V3 pool balances frozen beside the canonical journal. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_chain_v3_balance_snapshots (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_hash VARCHAR(66) NOT NULL,
     log_index INTEGER NOT NULL,
     pool_address VARCHAR(42) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     quote_address VARCHAR(42) NOT NULL,
     token_balance_raw NUMERIC(78,0) NOT NULL,
     quote_balance_raw NUMERIC(78,0) NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_chain_v3_balance_snapshots_pkey PRIMARY KEY (
       chain, block_hash, log_index
     ),
     CONSTRAINT rh_chain_v3_balance_snapshots_event_fkey FOREIGN KEY (
       chain, block_hash, log_index
     ) REFERENCES robinhood_chain_events(chain, block_hash, log_index) ON DELETE CASCADE,
     CONSTRAINT rh_chain_v3_balance_snapshots_values_check CHECK (
       chain = 'robinhood' AND log_index >= 0
       AND pool_address ~ '^0x[0-9a-f]{40}$'
       AND token_address ~ '^0x[0-9a-f]{40}$'
       AND quote_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> quote_address
       AND token_balance_raw >= 0 AND quote_balance_raw >= 0
     )
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 195 Robinhood V3 balance snapshots created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 195:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
