'use strict';

/** Stage 244 - append-only dispositions for preserved transfer evidence. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_evidence_dispositions (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index INTEGER NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     disposition VARCHAR(16) NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_evidence_dispositions_pkey PRIMARY KEY (
       chain, transaction_hash, log_index, block_time, disposition
     ),
     CONSTRAINT rh_wallet_transfer_evidence_dispositions_values_check CHECK (
       chain = 'robinhood' AND log_index >= 0
       AND transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND block_hash ~ '^0x[0-9a-f]{64}$'
       AND disposition IN ('orphaned', 'reclassified')
     )
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 244 Robinhood transfer evidence dispositions applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 244:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
