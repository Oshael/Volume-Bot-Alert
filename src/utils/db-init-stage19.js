/**
 * Etapa 19 - Token alert persistence foundation.
 * Rodar com: node src/utils/db-init-stage19.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_alert_events (
     id SERIAL PRIMARY KEY,
     rule_key VARCHAR(64) NOT NULL,
     token_address VARCHAR(64) NOT NULL,
     baseline_ts TIMESTAMPTZ NOT NULL,
     baseline_mcap NUMERIC(20, 2) NOT NULL,
     window_low_mcap NUMERIC(20, 2) NOT NULL,
     current_ts TIMESTAMPTZ NOT NULL,
     current_close_mcap NUMERIC(20, 2),
     dump_pct NUMERIC(10, 2) NOT NULL,
     threshold_pct NUMERIC(10, 2) NOT NULL,
     triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (rule_key, token_address, baseline_ts, current_ts)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_alert_events_rule_triggered_at
     ON token_alert_events(rule_key, triggered_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_alert_events_token_triggered_at
     ON token_alert_events(token_address, triggered_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS token_alert_rule_state (
     rule_key VARCHAR(64) NOT NULL,
     token_address VARCHAR(64) NOT NULL,
     status VARCHAR(32) NOT NULL DEFAULT 'idle',
     last_baseline_ts TIMESTAMPTZ,
     last_baseline_mcap NUMERIC(20, 2),
     last_window_low_mcap NUMERIC(20, 2),
     last_current_ts TIMESTAMPTZ,
     last_current_close_mcap NUMERIC(20, 2),
     last_alerted_at TIMESTAMPTZ,
     last_alerted_pct NUMERIC(10, 2),
     rearm_required BOOLEAN NOT NULL DEFAULT false,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (rule_key, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_alert_rule_state_updated_at
     ON token_alert_rule_state(updated_at DESC)`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 19 token alert persistence foundation created successfully');
    console.log('   - token_alert_events');
    console.log('   - token_alert_rule_state');
  } catch (err) {
    console.error('Failed to create stage 19 token alert persistence foundation:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
