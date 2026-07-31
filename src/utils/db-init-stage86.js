/**
 * Stage 86 - Optimistic versioning for Telegram connection delivery state.
 * Enables safe pause/resume callbacks without reviving suspended or disconnected links.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE telegram_connections
     ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'telegram_connections_version_check'
         AND conrelid = 'telegram_connections'::regclass
     ) THEN
       ALTER TABLE telegram_connections
         ADD CONSTRAINT telegram_connections_version_check CHECK (version > 0);
     END IF;
   END
   $$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 86 Telegram connection versioning created successfully');
  } catch (error) {
    console.error('Failed to create Stage 86 Telegram connection versioning:', error.message);
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
