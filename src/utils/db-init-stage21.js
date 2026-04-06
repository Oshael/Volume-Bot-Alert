/**
 * Etapa 21 - Meteora scheduling foundation.
 * Rodar com: node src/utils/db-init-stage21.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_catalog
     ADD COLUMN IF NOT EXISTS last_meteora_checked_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_meteora_checked_at
     ON token_catalog(last_meteora_checked_at ASC NULLS FIRST)`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_meteora_active_checked
     ON token_catalog(is_active_monitor_candidate, last_meteora_checked_at ASC NULLS FIRST, last_seen_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 21 Meteora scheduling fields created successfully');
    console.log('   - token_catalog.last_meteora_checked_at');
  } catch (err) {
    console.error('Failed to create stage 21 Meteora scheduling fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
