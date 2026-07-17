/**
 * Stage 59 - Promote minute volume buckets to chain-aware identity.
 * This changes storage identity only; Robinhood bucket writers remain disconnected.
 * Run with: node src/utils/db-init-stage59.js
 */
const db = require('../models/db');

const MIGRATION_LOCK_ID = 590001;
const ADD_CHAIN_STATEMENT = `ALTER TABLE token_market_volume_buckets_1m
  ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`;
const BUILD_IDENTITY_INDEX_STATEMENT = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  idx_token_market_volume_buckets_1m_chain_identity_full
  ON token_market_volume_buckets_1m(chain, token_address, bucket_ts)`;
const PROMOTE_IDENTITY_STATEMENT =
  `DO $migration$
   BEGIN
     ALTER TABLE token_market_volume_buckets_1m
       DROP CONSTRAINT IF EXISTS token_market_volume_buckets_1m_pkey;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'token_market_volume_buckets_1m_chain_pkey'
     ) THEN
       ALTER TABLE token_market_volume_buckets_1m
         ADD CONSTRAINT token_market_volume_buckets_1m_chain_pkey
         PRIMARY KEY USING INDEX idx_token_market_volume_buckets_1m_chain_identity_full;
     END IF;
   END
   $migration$`;
const BUILD_LOOKUP_INDEX_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_token_market_volume_buckets_1m_chain_addr_bucket_ts
  ON token_market_volume_buckets_1m(chain, token_address, bucket_ts DESC)`;
const DROP_LEGACY_INDEX_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_volume_buckets_1m_addr_bucket_ts`;
const DROP_PREPARATORY_INDEX_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_volume_buckets_1m_chain_identity`;

const STATEMENTS = [
  ADD_CHAIN_STATEMENT,
  BUILD_IDENTITY_INDEX_STATEMENT,
  PROMOTE_IDENTITY_STATEMENT,
  BUILD_LOOKUP_INDEX_STATEMENT,
  DROP_LEGACY_INDEX_STATEMENT,
  DROP_PREPARATORY_INDEX_STATEMENT,
];

async function hasPromotedIdentity() {
  const result = await db.query(
    `SELECT 1
       FROM pg_constraint
      WHERE conrelid = 'token_market_volume_buckets_1m'::regclass
        AND conname = 'token_market_volume_buckets_1m_chain_pkey'`,
  );
  return result.rowCount > 0;
}

async function init(options = {}) {
  const closePool = options.closePool !== false;
  let lockAcquired = false;
  try {
    // Session-level lock serializes manual/runtime invocations while concurrent
    // index creation keeps normal bucket writers available.
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await db.query(ADD_CHAIN_STATEMENT);
    if (!(await hasPromotedIdentity())) {
      await db.query(BUILD_IDENTITY_INDEX_STATEMENT);
    }
    await db.query(PROMOTE_IDENTITY_STATEMENT);
    await db.query(BUILD_LOOKUP_INDEX_STATEMENT);
    await db.query(DROP_LEGACY_INDEX_STATEMENT);
    await db.query(DROP_PREPARATORY_INDEX_STATEMENT);
    console.log('Stage 59 chain-aware minute volume bucket identity applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 59 minute volume bucket identity:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (lockAcquired) {
      try { await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]); } catch (_) {}
    }
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init, hasPromotedIdentity };
