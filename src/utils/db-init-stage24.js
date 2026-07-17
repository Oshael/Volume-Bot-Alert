/**
 * Etapa 24 - Token risk structural enrichment cache.
 * Rodar com: node src/utils/db-init-stage24.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_risk_enrichment (
     chain VARCHAR(16) NOT NULL DEFAULT 'solana',
     token_address VARCHAR(64) NOT NULL,
     source VARCHAR(32) NOT NULL DEFAULT 'helius',
     last_attempted_at TIMESTAMPTZ,
     last_enriched_at TIMESTAMPTZ,
     last_error TEXT,
     holder_count INTEGER,
     supply_amount VARCHAR(128),
     supply_decimals INTEGER,
     supply_ui_amount NUMERIC(30, 8),
     token_program VARCHAR(128),
     mint_authority VARCHAR(128),
     freeze_authority VARCHAR(128),
     mint_authority_active BOOLEAN NOT NULL DEFAULT false,
     freeze_authority_active BOOLEAN NOT NULL DEFAULT false,
     top_1_pct NUMERIC(10, 2),
     top_5_pct NUMERIC(10, 2),
     top_10_pct NUMERIC(10, 2),
     top_20_pct NUMERIC(10, 2),
     top_holders JSONB NOT NULL DEFAULT '[]'::jsonb,
     reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT token_risk_enrichment_chain_pkey PRIMARY KEY (chain, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_risk_enrichment_attempted_at
     ON token_risk_enrichment(last_attempted_at ASC NULLS FIRST)`,
  `CREATE INDEX IF NOT EXISTS idx_token_risk_enrichment_enriched_at
     ON token_risk_enrichment(last_enriched_at ASC NULLS FIRST)`,
  `CREATE INDEX IF NOT EXISTS idx_token_risk_enrichment_updated_at
     ON token_risk_enrichment(updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 24 token risk structural enrichment cache created successfully');
    console.log('   - token_risk_enrichment');
  } catch (err) {
    console.error('Failed to create stage 24 token risk structural enrichment cache:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
