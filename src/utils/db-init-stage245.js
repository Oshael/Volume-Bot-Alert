'use strict';

/** Stage 245 - opt-in preimages for bounded LIVE wallet-position recovery. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_position_reorg_preimages (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL,
     from_block BIGINT NOT NULL,
     through_block BIGINT NOT NULL,
     checkpoint_hash VARCHAR(66) NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     record_kind VARCHAR(16) NOT NULL,
     identity_key VARCHAR(85) NOT NULL,
     had_previous BOOLEAN NOT NULL,
     previous_row JSONB,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_position_reorg_preimages_pkey PRIMARY KEY (
       chain, projection_version, through_block, checkpoint_hash, record_kind, identity_key
     ),
     CONSTRAINT rh_wallet_position_reorg_preimages_values_check CHECK (
       chain = 'robinhood'
       AND projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND from_block >= 0 AND through_block >= from_block
       AND checkpoint_hash ~ '^0x[0-9a-f]{64}$'
       AND record_kind IN ('batch', 'position')
       AND ((record_kind = 'batch' AND identity_key = 'batch'
             AND NOT had_previous AND previous_row IS NULL)
         OR (record_kind = 'position'
             AND identity_key ~ '^0x[0-9a-f]{40}:0x[0-9a-f]{40}$'
             AND ((had_previous AND jsonb_typeof(previous_row) = 'object')
                  OR (NOT had_previous AND previous_row IS NULL))))
       AND expires_at = block_time + INTERVAL '3 days'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_position_reorg_preimages_expiry
     ON robinhood_wallet_position_reorg_preimages(expires_at, through_block)`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 245 Robinhood wallet-position preimages created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 245:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
