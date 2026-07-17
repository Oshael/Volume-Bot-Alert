/**
 * Stage 56 - Promote risk storage identities to chain-aware contracts.
 * This stage changes identity only; it does not enable Robinhood auto-classification.
 * Run with: node src/utils/db-init-stage56.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_risk_enrichment
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `ALTER TABLE token_risk_reviews
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `ALTER TABLE token_junk_evidence
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `DO $index$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_risk_enrichment_chain_pkey') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_token_risk_enrichment_chain_identity
         ON token_risk_enrichment(chain, token_address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_risk_reviews_chain_pkey') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_token_risk_reviews_chain_identity
         ON token_risk_reviews(chain, token_address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_junk_evidence_chain_key') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_token_junk_evidence_chain_identity
         ON token_junk_evidence(chain, token_address, assessment_fingerprint);
     END IF;
   END
   $index$`,
  `DO $migration$
   BEGIN
     ALTER TABLE token_risk_enrichment DROP CONSTRAINT IF EXISTS token_risk_enrichment_pkey;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_risk_enrichment_chain_pkey') THEN
       ALTER TABLE token_risk_enrichment
         ADD CONSTRAINT token_risk_enrichment_chain_pkey
         PRIMARY KEY USING INDEX idx_token_risk_enrichment_chain_identity;
     END IF;

     ALTER TABLE token_risk_reviews DROP CONSTRAINT IF EXISTS token_risk_reviews_pkey;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_risk_reviews_chain_pkey') THEN
       ALTER TABLE token_risk_reviews
         ADD CONSTRAINT token_risk_reviews_chain_pkey
         PRIMARY KEY USING INDEX idx_token_risk_reviews_chain_identity;
     END IF;

     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_junk_evidence_chain_key') THEN
       ALTER TABLE token_junk_evidence
         ADD CONSTRAINT token_junk_evidence_chain_key
         UNIQUE USING INDEX idx_token_junk_evidence_chain_identity;
     END IF;
     ALTER TABLE token_junk_evidence
       DROP CONSTRAINT IF EXISTS token_junk_evidence_token_address_assessment_fingerprint_key;
   END
   $migration$`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 56 chain-aware risk storage applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 56 risk storage:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init };
