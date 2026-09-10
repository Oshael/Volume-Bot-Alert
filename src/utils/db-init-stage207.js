'use strict';

/** Stage 207 - key the Robinhood trade lifecycle by canonical branch. */
const db = require('../models/db');

const MIGRATION_LOCK_ID = 2070001;
const IDENTITY_NAME = 'rh_wallet_swap_realtime_outbox_cycle_pkey';
const BUILD_IDENTITY_INDEX_STATEMENT = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  ${IDENTITY_NAME}
  ON robinhood_wallet_swap_realtime_outbox(
    chain, transaction_hash, log_index, block_hash, event_kind
  )`;
const PROMOTE_IDENTITY_STATEMENT = `DO $migration$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'robinhood_wallet_swap_realtime_outbox'::regclass
         AND conname = '${IDENTITY_NAME}'
         AND contype = 'p'
    ) THEN
      ALTER TABLE robinhood_wallet_swap_realtime_outbox
        DROP CONSTRAINT IF EXISTS rh_wallet_swap_realtime_outbox_pkey;
      ALTER TABLE robinhood_wallet_swap_realtime_outbox
        ADD CONSTRAINT ${IDENTITY_NAME}
        PRIMARY KEY USING INDEX ${IDENTITY_NAME};
    END IF;
  END
  $migration$`;
const STATEMENTS = Object.freeze([
  BUILD_IDENTITY_INDEX_STATEMENT,
  PROMOTE_IDENTITY_STATEMENT,
]);

async function hasPromotedIdentity(database = db) {
  const result = await database.query(
    `SELECT 1 FROM pg_constraint
      WHERE conrelid = 'robinhood_wallet_swap_realtime_outbox'::regclass
        AND conname = $1 AND contype = 'p'`,
    [IDENTITY_NAME]
  );
  return result.rowCount > 0;
}

async function removeInvalidIdentityIndex(database = db) {
  const result = await database.query(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [IDENTITY_NAME]
  );
  if (result.rows[0]?.indisvalid !== false) return false;
  await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${IDENTITY_NAME}`);
  return true;
}

async function init(options = {}) {
  const database = options.database || db;
  let lockAcquired = false;
  try {
    await database.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    if (!(await hasPromotedIdentity(database))) {
      await removeInvalidIdentityIndex(database);
      await database.query(BUILD_IDENTITY_INDEX_STATEMENT);
    }
    await database.query(PROMOTE_IDENTITY_STATEMENT);
    console.log('Stage 207 Robinhood trade lifecycle branch identity applied successfully');
  } finally {
    if (lockAcquired) {
      await database.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
        .catch(() => {});
    }
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 207:', error.message);
  process.exitCode = 1;
});

module.exports = {
  BUILD_IDENTITY_INDEX_STATEMENT,
  IDENTITY_NAME,
  PROMOTE_IDENTITY_STATEMENT,
  STATEMENTS,
  hasPromotedIdentity,
  init,
  removeInvalidIdentityIndex,
};
