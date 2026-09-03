'use strict';

/** Stage 192 - complete canonical transaction context for all live domains. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_chain_blocks
     ADD COLUMN IF NOT EXISTS capture_version SMALLINT NOT NULL DEFAULT 1`,
  `ALTER TABLE robinhood_chain_transactions
     ADD COLUMN IF NOT EXISTS nonce NUMERIC(78,0),
     ADD COLUMN IF NOT EXISTS value_wei NUMERIC(78,0)`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conname = 'rh_chain_blocks_capture_version_check') THEN
       ALTER TABLE robinhood_chain_blocks ADD CONSTRAINT rh_chain_blocks_capture_version_check
         CHECK (capture_version >= 1);
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conname = 'rh_chain_transactions_context_check') THEN
       ALTER TABLE robinhood_chain_transactions
         ADD CONSTRAINT rh_chain_transactions_context_check
         CHECK ((nonce IS NULL OR nonce >= 0) AND (value_wei IS NULL OR value_wei >= 0));
     END IF;
   END $$`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 192 Robinhood transaction context created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 192:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
