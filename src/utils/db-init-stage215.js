'use strict';

/** Stage 215 - durable canonical mint anchors for Robinhood token deployment tasks. */
const db = require('../models/db');

const TABLE = 'robinhood_token_deployment_outbox';

const STATEMENTS = Object.freeze([
  `ALTER TABLE ${TABLE}
     ADD COLUMN IF NOT EXISTS mint_block_number BIGINT,
     ADD COLUMN IF NOT EXISTS mint_block_hash VARCHAR(66),
     ADD COLUMN IF NOT EXISTS mint_transaction_hash VARCHAR(66)`,
  `ALTER TABLE ${TABLE}
     DROP CONSTRAINT IF EXISTS rh_token_deployment_outbox_mint_anchor_check,
     ADD CONSTRAINT rh_token_deployment_outbox_mint_anchor_check CHECK (
       (mint_block_number IS NULL AND mint_block_hash IS NULL
         AND mint_transaction_hash IS NULL)
       OR (mint_block_number IS NOT NULL
         AND mint_block_hash IS NOT NULL
         AND mint_transaction_hash IS NOT NULL
         AND mint_block_number >= 0
         AND mint_block_hash ~ '^0x[0-9a-f]{64}$'
         AND mint_transaction_hash ~ '^0x[0-9a-f]{64}$')
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_token_deployment_outbox_mint_claim
     ON ${TABLE}(status, next_attempt_at, mint_block_number DESC)
     WHERE mint_block_number IS NOT NULL`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 215 Robinhood deployment mint anchors applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 215:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, TABLE, init };
