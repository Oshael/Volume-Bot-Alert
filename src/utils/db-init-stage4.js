/**
 * Etapa 4 — Tabelas de configs individuais.
 * Rodar com: node src/utils/db-init-stage4.js
 * Seguro para rodar múltiplas vezes (IF NOT EXISTS em tudo).
 */
const db = require('../models/db');

const TABLES = `
  -- ── user_configs: key-value com whitelist no app ──────────────────
  CREATE TABLE IF NOT EXISTS user_configs (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config_key    VARCHAR(64) NOT NULL,
    config_value  VARCHAR(256) NOT NULL,
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, config_key)
  );

  CREATE INDEX IF NOT EXISTS idx_user_configs_user
    ON user_configs(user_id);

  -- ── user_tokens: manual tokens por user ───────────────────────────
  CREATE TABLE IF NOT EXISTS user_tokens (
    id        SERIAL PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address   VARCHAR(64) NOT NULL,
    label     VARCHAR(32),
    added_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, address)
  );

  CREATE INDEX IF NOT EXISTS idx_user_tokens_user
    ON user_tokens(user_id);

  -- ── user_blocklist: tokens bloqueados por user ────────────────────
  CREATE TABLE IF NOT EXISTS user_blocklist (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address     VARCHAR(64) NOT NULL,
    label       VARCHAR(32),
    blocked_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, address)
  );

  CREATE INDEX IF NOT EXISTS idx_user_blocklist_user
    ON user_blocklist(user_id);

  -- user_starred_tokens: favoritos por user
  CREATE TABLE IF NOT EXISTS user_starred_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address     VARCHAR(64) NOT NULL,
    starred_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, address)
  );

  CREATE INDEX IF NOT EXISTS idx_user_starred_tokens_user
    ON user_starred_tokens(user_id);

  -- user_pinned_monitored_tokens: pinned monitored ordering per user
  CREATE TABLE IF NOT EXISTS user_pinned_monitored_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address     VARCHAR(64) NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    pinned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, address)
  );

  CREATE INDEX IF NOT EXISTS idx_user_pinned_monitored_tokens_user_order
    ON user_pinned_monitored_tokens(user_id, sort_order, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_user_pinned_monitored_tokens_address
    ON user_pinned_monitored_tokens(address);

  -- user_bootstrap_tokens: baseline bootstrap tokens per user
  CREATE TABLE IF NOT EXISTS user_bootstrap_tokens (
    id        SERIAL PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address   VARCHAR(64) NOT NULL,
    added_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, address)
  );

  CREATE INDEX IF NOT EXISTS idx_user_bootstrap_tokens_user
    ON user_bootstrap_tokens(user_id);

  -- user_ui_prefs: preferências de interface por user
  CREATE TABLE IF NOT EXISTS user_ui_prefs (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );
`;

async function init() {
  try {
    await db.query(TABLES);
    console.log('✅ Stage 4 tables created successfully');
    console.log('   - user_configs');
    console.log('   - user_tokens');
    console.log('   - user_blocklist');
    console.log('   - user_starred_tokens');
    console.log('   - user_pinned_monitored_tokens');
    console.log('   - user_bootstrap_tokens');
    console.log('   - user_ui_prefs');
  } catch (err) {
    console.error('❌ Failed to create tables:', err.message);
    process.exit(1);
  } finally {
    try { await db.end(); } catch (_) { /* pool already closed or end not available */ }
  }
}

init();
