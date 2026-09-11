'use strict';

/** Stage 208 - bounded preimages for exact Robinhood transfer reorg rollback. */
const db = require('../models/db');

const RETENTION_DAYS = 3;
const TABLE = 'robinhood_wallet_transfer_reorg_journal';

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     aggregate_kind VARCHAR(32) NOT NULL,
     identity_key TEXT NOT NULL,
     had_previous BOOLEAN NOT NULL,
     previous_row JSONB,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_reorg_journal_pkey PRIMARY KEY (
       chain, projection_version, block_hash, aggregate_kind, identity_key
     ),
     CONSTRAINT rh_wallet_transfer_reorg_journal_chain_check CHECK (
       chain = 'robinhood'
     ),
     CONSTRAINT rh_wallet_transfer_reorg_journal_identity_check CHECK (
       projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND block_number >= 0
       AND block_hash ~ '^0x[0-9a-f]{64}$'
       AND aggregate_kind IN (
         'block_marker', 'edge', 'daily_summary', 'relationship_evidence'
       )
       AND LENGTH(identity_key) BETWEEN 1 AND 512
     ),
     CONSTRAINT rh_wallet_transfer_reorg_journal_preimage_check CHECK (
       (had_previous AND jsonb_typeof(previous_row) = 'object')
       OR (NOT had_previous AND previous_row IS NULL)
     ),
     CONSTRAINT rh_wallet_transfer_reorg_journal_retention_check CHECK (
       expires_at = block_time + INTERVAL '${RETENTION_DAYS} days'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_reorg_journal_expiry
     ON ${TABLE}(expires_at, block_number)`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_reorg_journal_recovery
     ON ${TABLE}(chain, block_number, block_hash, projection_version)`,
  `ALTER TABLE ${TABLE} SET (
     autovacuum_vacuum_scale_factor = 0.01,
     autovacuum_vacuum_threshold = 5000,
     autovacuum_analyze_scale_factor = 0.02,
     autovacuum_analyze_threshold = 5000
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 208 Robinhood transfer reorg journal created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 208:', error.message);
  process.exitCode = 1;
});

module.exports = { RETENTION_DAYS, STATEMENTS, TABLE, init };
