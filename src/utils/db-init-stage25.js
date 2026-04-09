/**
 * Etapa 25 - Manual token risk review labels.
 * Rodar com: node src/utils/db-init-stage25.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_risk_reviews (
     token_address VARCHAR(64) PRIMARY KEY,
     label VARCHAR(32) NOT NULL,
     notes TEXT,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_risk_reviews_label_updated_at
     ON token_risk_reviews(label, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_risk_reviews_updated_at
     ON token_risk_reviews(updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 25 token risk review labels created successfully');
    console.log('   - token_risk_reviews');
  } catch (err) {
    console.error('Failed to create stage 25 token risk review labels:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
