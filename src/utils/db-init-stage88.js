/**
 * Stage 88 - Destination-specific Telegram alert rule state.
 * Keeps cooldown, rearm and dedupe state isolated from dashboard alert state.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS telegram_alert_rule_states (
     profile_id BIGINT NOT NULL,
     chain VARCHAR(16) NOT NULL,
     rule_key VARCHAR(64) NOT NULL,
     token_address VARCHAR(128) NOT NULL,
     rule_version INTEGER NOT NULL,
     state_json JSONB NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT telegram_alert_rule_states_pkey
       PRIMARY KEY (profile_id, rule_key, token_address),
     CONSTRAINT telegram_alert_rule_states_profile_chain_fkey
       FOREIGN KEY (profile_id, chain)
       REFERENCES telegram_alert_profiles(id, chain)
       ON DELETE CASCADE,
     CONSTRAINT telegram_alert_rule_states_profile_rule_fkey
       FOREIGN KEY (profile_id, rule_key)
       REFERENCES telegram_alert_rule_settings(profile_id, rule_key)
       ON DELETE CASCADE,
     CONSTRAINT telegram_alert_rule_states_chain_check
       CHECK (chain IN ('solana', 'robinhood')),
     CONSTRAINT telegram_alert_rule_states_address_check
       CHECK (token_address = BTRIM(token_address) AND LENGTH(token_address) > 0),
     CONSTRAINT telegram_alert_rule_states_json_check
       CHECK (jsonb_typeof(state_json) = 'object'),
     CONSTRAINT telegram_alert_rule_states_rule_version_check CHECK (rule_version > 0),
     CONSTRAINT telegram_alert_rule_states_version_check CHECK (version > 0)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_alert_rule_states_profile_token
     ON telegram_alert_rule_states(profile_id, token_address)`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 88 Telegram alert rule state created successfully');
  } catch (error) {
    console.error('Failed to create Stage 88 Telegram alert rule state:', error.message);
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
