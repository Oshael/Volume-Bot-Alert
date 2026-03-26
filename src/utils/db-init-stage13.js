/**
 * Etapa 13 — Preferências de interface por usuário.
 * Rodar com: node src/utils/db-init-stage13.js
 */
const db = require('../models/db');

const TABLES = `
  CREATE TABLE IF NOT EXISTS user_ui_prefs (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );
`;

async function init() {
  try {
    await db.query(TABLES);
    console.log('Stage 13 UI preference table created successfully');
    console.log('   - user_ui_prefs');
  } catch (err) {
    console.error('Failed to create stage 13 tables:', err.message);
    process.exit(1);
  } finally {
    try { await db.end(); } catch (_) { /* pool already closed or end not available */ }
  }
}

init();
