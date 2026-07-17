/**
 * Stage 51 - Additive chain identity for catalog and generic market buckets.
 * Run with: node src/utils/db-init-stage51.js
 */
const db = require('../models/db');

const CHAIN_TABLES = Object.freeze([
  'token_market_buckets_1m',
  'token_market_volume_buckets_1m',
  'token_market_buckets_agg',
]);

const STATEMENTS = [
  `ALTER TABLE token_catalog
     ALTER COLUMN chain SET DEFAULT 'solana',
     ALTER COLUMN chain SET NOT NULL`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_catalog_chain_address_unique
     ON token_catalog(chain, address)`,
  `DO $migration$
   DECLARE table_name TEXT;
   DECLARE chain_not_null BOOLEAN;
   BEGIN
     FOREACH table_name IN ARRAY ARRAY[
       'token_market_buckets_1m',
       'token_market_volume_buckets_1m',
       'token_market_buckets_agg'
     ] LOOP
       EXECUTE format(
         'ALTER TABLE %I ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT ''solana''',
         table_name
       );
       SELECT attribute.attnotnull INTO chain_not_null
         FROM pg_attribute attribute
        WHERE attribute.attrelid = table_name::regclass
          AND attribute.attname = 'chain'
          AND NOT attribute.attisdropped;
       IF NOT chain_not_null THEN
         EXECUTE format('UPDATE %I SET chain = ''solana'' WHERE chain IS NULL', table_name);
       END IF;
       EXECUTE format(
         'ALTER TABLE %I ALTER COLUMN chain SET DEFAULT ''solana'', ALTER COLUMN chain SET NOT NULL',
         table_name
       );
     END LOOP;
   END
   $migration$`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_buckets_1m_chain_identity
     ON token_market_buckets_1m(chain, token_address, bucket_ts)
     WHERE chain <> 'solana'`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_volume_buckets_1m_chain_identity
     ON token_market_volume_buckets_1m(chain, token_address, bucket_ts)
     WHERE chain <> 'solana'`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_buckets_agg_chain_identity
     ON token_market_buckets_agg(chain, token_address, granularity_minutes, bucket_ts)
     WHERE chain <> 'solana'`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 51 chain-aware catalog and market schema applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 51 chain-aware schema:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) {
  init().catch(() => {});
}

module.exports = { CHAIN_TABLES, STATEMENTS, init };
