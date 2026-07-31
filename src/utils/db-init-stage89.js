/**
 * Stage 89 - Durable Telegram alert delivery outbox.
 * Adds persistence and ownership constraints without enabling runtime delivery.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_alert_profiles_delivery_identity
     ON telegram_alert_profiles(id, connection_id, chain)`,

  `CREATE TABLE IF NOT EXISTS telegram_alert_deliveries (
     id BIGSERIAL PRIMARY KEY,
     connection_id BIGINT NOT NULL,
     profile_id BIGINT NOT NULL,
     rule_key VARCHAR(64) NOT NULL,
     chain VARCHAR(16) NOT NULL,
     token_address VARCHAR(128) NOT NULL,
     dedupe_key VARCHAR(255) NOT NULL,
     event_payload JSONB NOT NULL,
     triggered_at TIMESTAMPTZ NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     telegram_message_id BIGINT,
     telegram_file_id TEXT,
     last_error_code VARCHAR(64),
     last_error TEXT,
     delivered_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT telegram_alert_deliveries_profile_fkey
       FOREIGN KEY (profile_id, connection_id, chain)
       REFERENCES telegram_alert_profiles(id, connection_id, chain)
       ON DELETE CASCADE,
     CONSTRAINT telegram_alert_deliveries_rule_fkey
       FOREIGN KEY (profile_id, rule_key)
       REFERENCES telegram_alert_rule_settings(profile_id, rule_key)
       ON DELETE CASCADE,
     CONSTRAINT telegram_alert_deliveries_dedupe_key
       UNIQUE (connection_id, dedupe_key),
     CONSTRAINT telegram_alert_deliveries_chain_check
       CHECK (chain IN ('solana', 'robinhood')),
     CONSTRAINT telegram_alert_deliveries_address_check
       CHECK (token_address = BTRIM(token_address) AND LENGTH(token_address) > 0),
     CONSTRAINT telegram_alert_deliveries_dedupe_check
       CHECK (dedupe_key = BTRIM(dedupe_key) AND LENGTH(dedupe_key) > 0),
     CONSTRAINT telegram_alert_deliveries_payload_check
       CHECK (jsonb_typeof(event_payload) = 'object'),
     CONSTRAINT telegram_alert_deliveries_status_check
       CHECK (status IN ('pending', 'claimed', 'retry', 'sent', 'cancelled', 'failed')),
     CONSTRAINT telegram_alert_deliveries_attempts_check
       CHECK (attempts >= 0),
     CONSTRAINT telegram_alert_deliveries_lease_check
       CHECK (
         (status = 'claimed' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
         OR
         (status <> 'claimed' AND lease_owner IS NULL AND lease_until IS NULL)
       ),
     CONSTRAINT telegram_alert_deliveries_sent_check
       CHECK ((status = 'sent') = (delivered_at IS NOT NULL)),
     CONSTRAINT telegram_alert_deliveries_message_check
       CHECK (telegram_message_id IS NULL OR telegram_message_id > 0)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_telegram_alert_deliveries_ready
     ON telegram_alert_deliveries(next_attempt_at, id)
     WHERE status IN ('pending', 'retry')`,

  `CREATE INDEX IF NOT EXISTS idx_telegram_alert_deliveries_claimed_lease
     ON telegram_alert_deliveries(lease_until, id)
     WHERE status = 'claimed'`,

  `CREATE INDEX IF NOT EXISTS idx_telegram_alert_deliveries_profile_history
     ON telegram_alert_deliveries(profile_id, triggered_at DESC)`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 89 Telegram alert delivery outbox created successfully');
  } catch (error) {
    console.error('Failed to create Stage 89 Telegram alert delivery outbox:', error.message);
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
