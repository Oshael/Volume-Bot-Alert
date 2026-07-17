/**
 * Stage 57 - Promote alert state and event dedupe to chain-aware contracts.
 * This changes persisted identity only; Robinhood alert triggering remains disabled.
 * Run with: node src/utils/db-init-stage57.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE user_alert_rule_state
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `ALTER TABLE user_alert_events
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `DO $index$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_alert_rule_state_chain_pkey') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_alert_rule_state_chain_identity
         ON user_alert_rule_state(user_id, rule_key, chain, token_address);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_alert_events_user_chain_dedupe_key') THEN
       CREATE UNIQUE INDEX IF NOT EXISTS idx_user_alert_events_user_chain_dedupe
         ON user_alert_events(user_id, chain, dedupe_key);
     END IF;
   END
   $index$`,
  `DO $migration$
   BEGIN
     ALTER TABLE user_alert_rule_state
       DROP CONSTRAINT IF EXISTS user_alert_rule_state_pkey;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_alert_rule_state_chain_pkey') THEN
       ALTER TABLE user_alert_rule_state
         ADD CONSTRAINT user_alert_rule_state_chain_pkey
         PRIMARY KEY USING INDEX idx_user_alert_rule_state_chain_identity;
     END IF;

     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_alert_events_user_chain_dedupe_key') THEN
       ALTER TABLE user_alert_events
         ADD CONSTRAINT user_alert_events_user_chain_dedupe_key
         UNIQUE USING INDEX idx_user_alert_events_user_chain_dedupe;
     END IF;
     ALTER TABLE user_alert_events
       DROP CONSTRAINT IF EXISTS user_alert_events_user_id_dedupe_key_key;
   END
   $migration$`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 57 chain-aware alert state and event identity applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 57 alert identity:', error.message);
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
