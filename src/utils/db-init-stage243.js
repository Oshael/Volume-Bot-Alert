'use strict';

/** Stage 243 - preserve unknown transfer evidence independently of raw partitions. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_pending_evidence (
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
     classification_version VARCHAR(64) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_pending_evidence_pkey PRIMARY KEY (
       chain, transaction_hash, log_index, block_time
     ),
     CONSTRAINT rh_wallet_transfer_pending_evidence_values_check CHECK (
       chain = 'robinhood'
       AND block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
       AND amount_raw >= 0
       AND block_hash ~ '^0x[0-9a-f]{64}$'
       AND transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
       AND from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$'
       AND classification_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_pending_evidence_day
     ON robinhood_wallet_transfer_pending_evidence(
       chain, block_time, block_number, transaction_index, log_index
     )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 243 Robinhood pending transfer evidence applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 243:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
