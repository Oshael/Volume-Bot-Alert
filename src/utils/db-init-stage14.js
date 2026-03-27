/**
 * Etapa 14 — Grace window para tokens PumpFun migrados.
 * Rodar com: node src/utils/db-init-stage14.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS migration_grace_until TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_migration_grace_until
     ON token_catalog(migration_grace_until ASC)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 14 migration grace fields created successfully');
    console.log('   - token_catalog.migration_grace_until');
  } catch (err) {
    console.error('Failed to create stage 14 fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
