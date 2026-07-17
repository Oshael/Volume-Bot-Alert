/**
 * Stage 55 - Promote user/admin block identities and evidence to chain-aware contracts.
 * Run with: node src/utils/db-init-stage55.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE user_blocklist
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `ALTER TABLE admin_blocked_tokens
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `ALTER TABLE admin_block_evidence
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `DO $index$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocklist_user_chain_address_key') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_blocklist_chain_identity
         ON user_blocklist(user_id, chain, address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_blocked_tokens_chain_pkey') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_blocked_tokens_chain_address
         ON admin_blocked_tokens(chain, address);
     END IF;
   END
   $index$`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_blocklist_user_chain_address_key') THEN
       ALTER TABLE user_blocklist
         ADD CONSTRAINT user_blocklist_user_chain_address_key
         UNIQUE USING INDEX idx_user_blocklist_chain_identity;
     END IF;
     ALTER TABLE user_blocklist
       DROP CONSTRAINT IF EXISTS user_blocklist_user_id_address_key;

     ALTER TABLE admin_blocked_tokens
       DROP CONSTRAINT IF EXISTS admin_blocked_tokens_pkey;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_blocked_tokens_chain_pkey') THEN
       ALTER TABLE admin_blocked_tokens
         ADD CONSTRAINT admin_blocked_tokens_chain_pkey
         PRIMARY KEY USING INDEX idx_admin_blocked_tokens_chain_address;
     END IF;
   END
   $migration$`,
  `CREATE INDEX IF NOT EXISTS idx_admin_block_evidence_chain_token_created
     ON admin_block_evidence(chain, token_address, created_at DESC, id DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 55 chain-aware blocklists and evidence applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 55 blocklists and evidence:', error.message);
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
