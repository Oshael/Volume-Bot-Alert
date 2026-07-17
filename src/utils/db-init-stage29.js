const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_alert_rule_state (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     rule_key VARCHAR(64) NOT NULL,
     chain VARCHAR(16) NOT NULL DEFAULT 'solana',
     token_address VARCHAR(64) NOT NULL,
     status VARCHAR(32) NOT NULL DEFAULT 'idle',
     last_alerted_at TIMESTAMPTZ,
     last_alerted_value NUMERIC(20, 4),
     last_alerted_pct NUMERIC(10, 2),
     cooldown_until TIMESTAMPTZ,
     rearm_required BOOLEAN NOT NULL DEFAULT false,
     last_fingerprint VARCHAR(255),
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, rule_key, chain, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_rule_state_user_rule_updated
     ON user_alert_rule_state(user_id, rule_key, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_rule_state_rule_cooldown
     ON user_alert_rule_state(rule_key, cooldown_until ASC NULLS FIRST, updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 29 user alert rule state created successfully');
    console.log('   - user_alert_rule_state');
  } catch (err) {
    console.error('Failed to create stage 29 user alert rule state:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
