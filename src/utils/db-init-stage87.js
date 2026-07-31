/**
 * Stage 87 - Durable Telegram numeric-input sessions.
 * Keeps short-lived conversational state outside the command handler.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS telegram_input_sessions (
     telegram_user_id BIGINT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     action VARCHAR(32) NOT NULL,
     payload_json JSONB NOT NULL,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT telegram_input_sessions_identity_check CHECK (telegram_user_id > 0),
     CONSTRAINT telegram_input_sessions_action_check
       CHECK (action IN ('edit_rule_setting')),
     CONSTRAINT telegram_input_sessions_payload_check
       CHECK (jsonb_typeof(payload_json) = 'object'),
     CONSTRAINT telegram_input_sessions_expiry_check CHECK (expires_at > created_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_input_sessions_expiry
     ON telegram_input_sessions(expires_at)`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 87 Telegram input sessions created successfully');
  } catch (error) {
    console.error('Failed to create Stage 87 Telegram input sessions:', error.message);
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
