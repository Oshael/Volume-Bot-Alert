/**
 * Stage 84 - Telegram connection and update intake foundation.
 * Creates durable private-chat links, one-time link tokens, and update dedupe.
 * It does not expose a webhook or enable Telegram delivery.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS telegram_connections (
     id BIGSERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     telegram_user_id BIGINT NOT NULL,
     chat_id BIGINT NOT NULL,
     username VARCHAR(64),
     first_name VARCHAR(255),
     status VARCHAR(24) NOT NULL DEFAULT 'active',
     linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     disconnected_at TIMESTAMPTZ,
     access_suspended_at TIMESTAMPTZ,
     last_update_id BIGINT,
     last_delivery_at TIMESTAMPTZ,
     last_error_code VARCHAR(64),
     last_error_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT telegram_connections_identity_check
       CHECK (telegram_user_id > 0 AND chat_id > 0),
     CONSTRAINT telegram_connections_status_check
       CHECK (status IN ('active', 'paused', 'access_suspended', 'disconnected')),
     CONSTRAINT telegram_connections_disconnected_check
       CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL)),
     CONSTRAINT telegram_connections_access_suspended_check
       CHECK ((status = 'access_suspended') = (access_suspended_at IS NOT NULL))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_connections_active_user
     ON telegram_connections(user_id) WHERE status <> 'disconnected'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_connections_active_telegram_user
     ON telegram_connections(telegram_user_id) WHERE status <> 'disconnected'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_connections_active_chat
     ON telegram_connections(chat_id) WHERE status <> 'disconnected'`,

  `CREATE TABLE IF NOT EXISTS telegram_link_tokens (
     id BIGSERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash CHAR(64) NOT NULL UNIQUE,
     expires_at TIMESTAMPTZ NOT NULL,
     consumed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT telegram_link_tokens_hash_check
       CHECK (token_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT telegram_link_tokens_expiry_check
       CHECK (expires_at > created_at),
     CONSTRAINT telegram_link_tokens_consumed_check
       CHECK (consumed_at IS NULL OR consumed_at >= created_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_user_expiry
     ON telegram_link_tokens(user_id, expires_at DESC)`,

  `CREATE TABLE IF NOT EXISTS telegram_updates (
     update_id BIGINT PRIMARY KEY,
     received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     processed_at TIMESTAMPTZ,
     status VARCHAR(16) NOT NULL DEFAULT 'received',
     last_error TEXT,
     CONSTRAINT telegram_updates_id_check CHECK (update_id >= 0),
     CONSTRAINT telegram_updates_status_check
       CHECK (status IN ('received', 'processed', 'failed')),
     CONSTRAINT telegram_updates_processed_check
       CHECK ((status = 'received') = (processed_at IS NULL))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_updates_status_received
     ON telegram_updates(status, received_at) WHERE status <> 'processed'`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 84 Telegram integration foundation created successfully');
  } catch (error) {
    console.error('Failed to create Stage 84 Telegram integration foundation:', error.message);
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
