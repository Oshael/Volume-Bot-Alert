'use strict';

/** Stage 233 - resumable preparation of the Robinhood holder legacy manifest. */
const db = require('../models/db');

const PROGRESS_TABLE = 'robinhood_holder_legacy_coverage_builds';
const MANIFEST_BLOCKS_CONSTRAINT = 'rh_holder_legacy_manifest_blocks_check';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_legacy_coverage_manifest
     DROP CONSTRAINT IF EXISTS ${MANIFEST_BLOCKS_CONSTRAINT},
     ADD CONSTRAINT ${MANIFEST_BLOCKS_CONSTRAINT} CHECK (
       coverage_generation >= 0 AND baseline_deployment_block >= 0
       AND baseline_backfill_next_block >= baseline_deployment_block
       AND baseline_holder_count >= 0
     ) NOT VALID`,
  `ALTER TABLE robinhood_holder_legacy_coverage_manifest
     VALIDATE CONSTRAINT ${MANIFEST_BLOCKS_CONSTRAINT}`,
  `CREATE TABLE IF NOT EXISTS ${PROGRESS_TABLE} (
     chain VARCHAR(16) PRIMARY KEY DEFAULT 'robinhood',
     pass BIGINT NOT NULL DEFAULT 1,
     after_token_address VARCHAR(42) NOT NULL DEFAULT '${ZERO_ADDRESS}',
     scanned BIGINT NOT NULL DEFAULT 0,
     inserted BIGINT NOT NULL DEFAULT 0,
     rejected BIGINT NOT NULL DEFAULT 0,
     completed_at TIMESTAMPTZ,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_legacy_build_chain_check CHECK (chain='robinhood'),
     CONSTRAINT rh_holder_legacy_build_values_check CHECK (
       pass > 0 AND scanned >= 0 AND inserted >= 0 AND rejected >= 0
       AND after_token_address ~ '^0x[0-9a-f]{40}$')
   )`,
  `INSERT INTO ${PROGRESS_TABLE} (chain) VALUES ('robinhood')
   ON CONFLICT (chain) DO NOTHING`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      for (const statement of STATEMENTS) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then(() => {
  console.log('Stage 233 Robinhood holder legacy manifest builder schema created successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 233:', error.message);
  process.exitCode = 1;
});

module.exports = { MANIFEST_BLOCKS_CONSTRAINT, PROGRESS_TABLE, STATEMENTS, ZERO_ADDRESS, init };
