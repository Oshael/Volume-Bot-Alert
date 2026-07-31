/**
 * Stage 85 - Independent Telegram alert profiles and rule settings.
 * Keeps destination configuration separate from dashboard user_config rows.
 * Input sessions and unresolved sparkline-window defaults are intentionally
 * deferred until their closed product contracts exist.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_connections_id_user
     ON telegram_connections(id, user_id)`,

  `CREATE TABLE IF NOT EXISTS telegram_alert_profiles (
     id BIGSERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     connection_id BIGINT NOT NULL,
     chain VARCHAR(16) NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT TRUE,
     sparkline_enabled BOOLEAN NOT NULL DEFAULT TRUE,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT telegram_alert_profiles_connection_user_fkey
       FOREIGN KEY (connection_id, user_id)
       REFERENCES telegram_connections(id, user_id)
       ON DELETE CASCADE,
     CONSTRAINT telegram_alert_profiles_user_chain_key UNIQUE (user_id, chain),
     CONSTRAINT telegram_alert_profiles_id_chain_key UNIQUE (id, chain),
     CONSTRAINT telegram_alert_profiles_chain_check
       CHECK (chain IN ('solana', 'robinhood')),
     CONSTRAINT telegram_alert_profiles_version_check CHECK (version > 0)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_alert_profiles_connection_enabled
     ON telegram_alert_profiles(connection_id, enabled, chain)`,

  `CREATE TABLE IF NOT EXISTS telegram_alert_rule_settings (
     id BIGSERIAL PRIMARY KEY,
     profile_id BIGINT NOT NULL,
     chain VARCHAR(16) NOT NULL,
     rule_key VARCHAR(64) NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT TRUE,
     settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT telegram_alert_rule_settings_profile_chain_fkey
       FOREIGN KEY (profile_id, chain)
       REFERENCES telegram_alert_profiles(id, chain)
       ON DELETE CASCADE,
     CONSTRAINT telegram_alert_rule_settings_profile_rule_key
       UNIQUE (profile_id, rule_key),
     CONSTRAINT telegram_alert_rule_settings_chain_rule_check
       CHECK (
         (
           chain = 'solana'
           AND rule_key IN (
             'monitored-vol', 'monitored-mcap', 'hvnc',
             'recent-surge-1h', 'recent-surge-6h',
             'old-week-surge-1h', 'old-week-surge-6h',
             'meteora-surge'
           )
         )
         OR (
           chain = 'robinhood'
           AND rule_key IN (
             'monitored-vol', 'monitored-fdv', 'robinhood-hvnc-v2',
             'recent-surge-1h', 'recent-surge-6h',
             'old-week-surge-1h', 'old-week-surge-6h'
           )
         )
       ),
     CONSTRAINT telegram_alert_rule_settings_json_check
       CHECK (jsonb_typeof(settings_json) = 'object'),
     CONSTRAINT telegram_alert_rule_settings_version_check CHECK (version > 0)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_alert_rule_settings_profile_enabled
     ON telegram_alert_rule_settings(profile_id, enabled, rule_key)`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 85 Telegram alert profile schema created successfully');
  } catch (error) {
    console.error('Failed to create Stage 85 Telegram alert profile schema:', error.message);
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
