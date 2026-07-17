/**
 * Stage 62 - Promote aggregate OHLC buckets to chain-aware identity and indexes.
 * This changes legacy storage identity only; Robinhood writes remain disabled
 * because this table cannot preserve exact EVM prices or every v4 pool id.
 * Run with: node src/utils/db-init-stage62.js
 */
const db = require('../models/db');

const MIGRATION_LOCK_ID = 620001;
const ADD_CHAIN_STATEMENT = `ALTER TABLE token_market_buckets_agg
  ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`;
const BUILD_IDENTITY_INDEX_STATEMENT = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  idx_token_market_buckets_agg_chain_identity_full
  ON token_market_buckets_agg(chain, token_address, granularity_minutes, bucket_ts)`;
const PROMOTE_IDENTITY_STATEMENT = `DO $migration$
  BEGIN
    ALTER TABLE token_market_buckets_agg
      DROP CONSTRAINT IF EXISTS token_market_buckets_agg_pkey;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'token_market_buckets_agg'::regclass
        AND conname = 'token_market_buckets_agg_chain_pkey'
    ) THEN
      ALTER TABLE token_market_buckets_agg
        ADD CONSTRAINT token_market_buckets_agg_chain_pkey
        PRIMARY KEY USING INDEX idx_token_market_buckets_agg_chain_identity_full;
    END IF;
  END
  $migration$`;
const BUILD_LOOKUP_INDEX_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_token_market_buckets_agg_chain_lookup
  ON token_market_buckets_agg(chain, token_address, granularity_minutes, bucket_ts DESC)
  WHERE close_mcap IS NOT NULL`;
const BUILD_BUCKET_INDEX_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_token_market_buckets_agg_chain_bucket_ts
  ON token_market_buckets_agg(chain, granularity_minutes, bucket_ts DESC)`;
const DROP_LEGACY_LOOKUP_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_agg_lookup`;
const DROP_LEGACY_BUCKET_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_agg_bucket_ts`;
const DROP_PREPARATORY_INDEX_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_agg_chain_identity`;

const STATEMENTS = [
  ADD_CHAIN_STATEMENT,
  BUILD_IDENTITY_INDEX_STATEMENT,
  PROMOTE_IDENTITY_STATEMENT,
  BUILD_LOOKUP_INDEX_STATEMENT,
  BUILD_BUCKET_INDEX_STATEMENT,
  DROP_LEGACY_LOOKUP_STATEMENT,
  DROP_LEGACY_BUCKET_STATEMENT,
  DROP_PREPARATORY_INDEX_STATEMENT,
];

async function hasPromotedIdentity() {
  const result = await db.query(
    `SELECT 1
       FROM pg_constraint
      WHERE conrelid = 'token_market_buckets_agg'::regclass
        AND conname = 'token_market_buckets_agg_chain_pkey'`,
  );
  return result.rowCount > 0;
}

async function removeInvalidIndex(indexName) {
  const result = await db.query(
    `SELECT index_state.indisvalid
       FROM pg_index index_state
      WHERE index_state.indexrelid = to_regclass($1)`,
    [indexName],
  );
  if (result.rows[0]?.indisvalid !== false) return false;
  console.log(`Stage 62: removing interrupted invalid index ${indexName}...`);
  await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
  return true;
}

async function init(options = {}) {
  const closePool = options.closePool !== false;
  let lockAcquired = false;
  try {
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await db.query(ADD_CHAIN_STATEMENT);
    if (!(await hasPromotedIdentity())) {
      await removeInvalidIndex('idx_token_market_buckets_agg_chain_identity_full');
      console.log('Stage 62: building aggregate chain identity index...');
      await db.query(BUILD_IDENTITY_INDEX_STATEMENT);
    }
    await db.query(PROMOTE_IDENTITY_STATEMENT);
    await removeInvalidIndex('idx_token_market_buckets_agg_chain_lookup');
    console.log('Stage 62: building aggregate chain lookup index...');
    await db.query(BUILD_LOOKUP_INDEX_STATEMENT);
    await removeInvalidIndex('idx_token_market_buckets_agg_chain_bucket_ts');
    console.log('Stage 62: building aggregate chain time index...');
    await db.query(BUILD_BUCKET_INDEX_STATEMENT);
    await db.query(DROP_LEGACY_LOOKUP_STATEMENT);
    await db.query(DROP_LEGACY_BUCKET_STATEMENT);
    await db.query(DROP_PREPARATORY_INDEX_STATEMENT);
    console.log('Stage 62 chain-aware aggregate OHLC bucket identity applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 62 aggregate OHLC bucket identity:', error.message);
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

module.exports = { STATEMENTS, init, hasPromotedIdentity, removeInvalidIndex };
