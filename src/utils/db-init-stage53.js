/**
 * Stage 53 - Promote the token catalog identity from address to chain + address.
 * Run with: node src/utils/db-init-stage53.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_catalog_chain_address_unique
     ON token_catalog(chain, address)`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'token_catalog'::regclass
         AND conname = 'token_catalog_chain_address_key'
     ) THEN
       ALTER TABLE token_catalog
         ADD CONSTRAINT token_catalog_chain_address_key
         UNIQUE USING INDEX idx_token_catalog_chain_address_unique;
     END IF;

     ALTER TABLE token_catalog
       DROP CONSTRAINT IF EXISTS token_catalog_address_key;
   END
   $migration$`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 53 composite token catalog identity applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 53 token catalog identity:', error.message);
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

module.exports = { STATEMENTS, init };
