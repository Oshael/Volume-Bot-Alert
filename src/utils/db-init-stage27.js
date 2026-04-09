/**
 * Etapa 27 - Token risk review source tracking.
 * Rodar com: node src/utils/db-init-stage27.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_risk_reviews
     ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'manual'`,
  `UPDATE token_risk_reviews
     SET source = 'manual'
   WHERE source IS NULL OR TRIM(source) = ''`,
  `CREATE INDEX IF NOT EXISTS idx_token_risk_reviews_source_label_updated_at
     ON token_risk_reviews(source, label, updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 27 token risk review sources created successfully');
    console.log('   - token_risk_reviews.source');
  } catch (err) {
    console.error('Failed to create stage 27 token risk review sources:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
