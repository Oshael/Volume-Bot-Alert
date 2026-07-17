/**
 * Stage 48 - User custom alert rules.
 * Run with: node src/utils/db-init-stage48.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_custom_alert_rules (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     chain VARCHAR(16) NOT NULL DEFAULT 'solana',
     token_address VARCHAR(64) NOT NULL,
     title VARCHAR(64) NOT NULL,
     metric VARCHAR(16) NOT NULL,
     operator VARCHAR(16) NOT NULL,
     target_value NUMERIC(30, 12) NOT NULL,
     color_hex VARCHAR(7),
     sound_name VARCHAR(128),
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     triggered_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT user_custom_alert_rules_metric_check CHECK (metric IN ('price', 'mcap')),
     CONSTRAINT user_custom_alert_rules_operator_check CHECK (operator IN ('cross_above', 'cross_below')),
     CONSTRAINT user_custom_alert_rules_status_check CHECK (status IN ('active', 'triggered', 'disabled')),
     CONSTRAINT user_custom_alert_rules_target_positive_check CHECK (target_value > 0)
   )`,
  `ALTER TABLE user_custom_alert_rules
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `CREATE INDEX IF NOT EXISTS idx_user_custom_alert_rules_user_status
     ON user_custom_alert_rules(user_id, status, updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_user_custom_alert_rules_chain_token_active
     ON user_custom_alert_rules(chain, token_address, status, updated_at DESC, id DESC)
     WHERE status = 'active'`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 48 user custom alert rules created successfully');
    console.log('   - user_custom_alert_rules');
  } catch (err) {
    console.error('Failed to create stage 48 user custom alert rules:', err.message);
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
