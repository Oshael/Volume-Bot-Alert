/**
 * Etapa 40 - Monitored token exit events.
 * Rodar com: node src/utils/db-init-stage40.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS monitored_token_exit_events (
     id SERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'solana',
     token_address VARCHAR(64) NOT NULL,
     exit_reason VARCHAR(96) NOT NULL,
     exit_source VARCHAR(64),
     previous_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     current_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     details JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `ALTER TABLE monitored_token_exit_events
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `CREATE INDEX IF NOT EXISTS idx_monitored_exit_events_chain_token
     ON monitored_token_exit_events(chain, token_address, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_monitored_token_exit_events_reason_created
     ON monitored_token_exit_events(exit_reason, created_at DESC, id DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 40 monitored token exit events table created successfully');
    console.log('   - monitored_token_exit_events');
  } catch (err) {
    console.error('Failed to create stage 40 monitored token exit events table:', err.message);
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
