/**
 * Etapa 26 - Dex runtime enrichment fields on token_catalog.
 * Rodar com: node src/utils/db-init-stage26.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_dex_id VARCHAR(64)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_liquidity_usd NUMERIC(20, 2)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_txns_1h_buys INTEGER`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_txns_1h_sells INTEGER`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_txns_24h_buys INTEGER`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_txns_24h_sells INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_liquidity_usd
     ON token_catalog(last_liquidity_usd DESC NULLS LAST)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 26 Dex runtime enrichment fields created successfully');
    console.log('   - token_catalog liquidity and txns fields');
  } catch (err) {
    console.error('Failed to create stage 26 Dex runtime enrichment fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
