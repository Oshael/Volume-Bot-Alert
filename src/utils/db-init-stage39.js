/**
 * Etapa 39 - Admin block evidence snapshots.
 * Rodar com: node src/utils/db-init-stage39.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admin_block_evidence (
     id SERIAL PRIMARY KEY,
     token_address VARCHAR(64) NOT NULL,
     ban_label VARCHAR(160),
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     pipeline VARCHAR(64) NOT NULL,
     source VARCHAR(64),
     catalog_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     market_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     risk_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     meteora_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     gmgn_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
     rule_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_block_evidence_token_created
     ON admin_block_evidence(token_address, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_block_evidence_pipeline_created
     ON admin_block_evidence(pipeline, created_at DESC, id DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 39 admin block evidence table created successfully');
    console.log('   - admin_block_evidence');
  } catch (err) {
    console.error('Failed to create stage 39 admin block evidence table:', err.message);
    process.exit(1);
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) {
  init();
}

module.exports = { init, STATEMENTS };
