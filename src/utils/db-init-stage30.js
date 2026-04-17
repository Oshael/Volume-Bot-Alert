const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_alert_events (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     rule_key VARCHAR(64) NOT NULL,
     kind VARCHAR(64) NOT NULL,
     token_address VARCHAR(64) NOT NULL,
     dedupe_key VARCHAR(255) NOT NULL,
     payload JSONB NOT NULL DEFAULT '{}'::jsonb,
     triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (user_id, dedupe_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_events_user_rule_triggered
     ON user_alert_events(user_id, rule_key, triggered_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_events_user_created
     ON user_alert_events(user_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_user_alert_events_user_token_triggered
     ON user_alert_events(user_id, token_address, triggered_at DESC, id DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 30 user alert events created successfully');
    console.log('   - user_alert_events');
  } catch (err) {
    console.error('Failed to create stage 30 user alert events:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
