/**
 * Etapa 23 - Market bucket pair diagnostics.
 * Rodar com: node src/utils/db-init-stage23.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_market_buckets_1m
     ADD COLUMN IF NOT EXISTS pair_address VARCHAR(64)`,
  `CREATE INDEX IF NOT EXISTS idx_token_market_buckets_1m_pair_bucket_ts
     ON token_market_buckets_1m(pair_address, bucket_ts DESC)
     WHERE pair_address IS NOT NULL`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 23 market bucket pair diagnostics created successfully');
    console.log('   - token_market_buckets_1m.pair_address');
  } catch (err) {
    console.error('Failed to create stage 23 market bucket pair diagnostics:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
