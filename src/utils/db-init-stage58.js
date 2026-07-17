/**
 * Stage 58 - Complete chain-aware custom/admin/exit alert storage indexes.
 * This stage does not enable Robinhood matchers, review automation, or exit detection.
 * Run with: node src/utils/db-init-stage58.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE user_custom_alert_rules
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `ALTER TABLE admin_token_review_alerts
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `ALTER TABLE monitored_token_exit_events
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `CREATE INDEX IF NOT EXISTS idx_user_custom_alert_rules_chain_token_active
     ON user_custom_alert_rules(chain, token_address, status, updated_at DESC, id DESC)
     WHERE status = 'active'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_review_alerts_open_chain_token_kind
     ON admin_token_review_alerts(chain, token_address, alert_kind)
     WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS idx_admin_token_review_alerts_chain_token_created
     ON admin_token_review_alerts(chain, token_address, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_monitored_exit_events_chain_token
     ON monitored_token_exit_events(chain, token_address, created_at DESC, id DESC)`,
  `DROP INDEX IF EXISTS idx_user_custom_alert_rules_token_active`,
  `DROP INDEX IF EXISTS idx_admin_token_review_alerts_open_token_kind`,
  `DROP INDEX IF EXISTS idx_admin_token_review_alerts_token_created`,
  `DROP INDEX IF EXISTS idx_monitored_token_exit_events_token_created`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 58 chain-aware custom/admin/exit alert storage applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 58 alert storage:', error.message);
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
