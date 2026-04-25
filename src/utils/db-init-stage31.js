const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_junk_evidence (
     id SERIAL PRIMARY KEY,
     token_address VARCHAR(64) NOT NULL,
     label VARCHAR(32) NOT NULL,
     source VARCHAR(32) NOT NULL DEFAULT 'auto_sync',
     assessment_fingerprint VARCHAR(64) NOT NULL,
     assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
     catalog_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     market_history JSONB NOT NULL DEFAULT '{}'::jsonb,
     meteora_history JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (token_address, assessment_fingerprint)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_junk_evidence_token_created
     ON token_junk_evidence(token_address, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_junk_evidence_label_created
     ON token_junk_evidence(label, created_at DESC, id DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 31 token junk evidence created successfully');
    console.log('   - token_junk_evidence');
  } catch (err) {
    console.error('Failed to create stage 31 token junk evidence:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
