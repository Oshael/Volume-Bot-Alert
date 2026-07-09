/**
 * Stage 49 - Shared user alert presence.
 * Run with: node src/utils/db-init-stage49.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_alert_presences (
     id BIGSERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     session_key VARCHAR(128) NOT NULL,
     socket_id VARCHAR(128) NOT NULL,
     web_instance_id VARCHAR(128) NOT NULL,
     mode VARCHAR(16) NOT NULL DEFAULT 'inactive',
     last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     foreground_seen_at TIMESTAMPTZ,
     hidden_started_at TIMESTAMPTZ,
     hidden_grace_until_at TIMESTAMPTZ,
     active_until_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     disconnected_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT user_alert_presences_mode_check CHECK (mode IN ('foreground', 'hidden', 'inactive'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_alert_presences_web_socket
     ON user_alert_presences(web_instance_id, socket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_presences_user_active
     ON user_alert_presences(user_id, active_until_at DESC)
     WHERE disconnected_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_presences_expiration
     ON user_alert_presences(active_until_at)`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_presences_session
     ON user_alert_presences(user_id, session_key)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 49 shared user alert presence created successfully');
    console.log('   - user_alert_presences');
  } catch (err) {
    console.error('Failed to create stage 49 shared user alert presence:', err.message);
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
