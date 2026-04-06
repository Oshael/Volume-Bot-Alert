/**
 * Etapa 20 - Alert delivery cursors.
 * Rodar com: node src/utils/db-init-stage20.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS alert_delivery_cursors (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     rule_key VARCHAR(64) NOT NULL,
     last_seen_event_id INTEGER,
     last_acked_event_id INTEGER,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, rule_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_alert_delivery_cursors_updated_at
     ON alert_delivery_cursors(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_delivery_cursors_rule_updated_at
     ON alert_delivery_cursors(rule_key, updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 20 alert delivery cursors created successfully');
    console.log('   - alert_delivery_cursors');
  } catch (err) {
    console.error('Failed to create stage 20 alert delivery cursors:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
