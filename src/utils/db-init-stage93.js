/**
 * Stage 93 - Durable Telegram access reactivation marker.
 * Records that access recovered while delivery remains suspended for safe baselining.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE telegram_connections
     ADD COLUMN IF NOT EXISTS access_reactivation_requested_at TIMESTAMPTZ`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'telegram_connections_reactivation_check'
         AND conrelid = 'telegram_connections'::regclass
     ) THEN
       ALTER TABLE telegram_connections
         ADD CONSTRAINT telegram_connections_reactivation_check
         CHECK (
           access_reactivation_requested_at IS NULL
           OR status = 'access_suspended'
         );
     END IF;
   END
   $$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 93 Telegram access reactivation marker created successfully');
  } catch (error) {
    console.error('Failed to create Stage 93 Telegram reactivation marker:', error.message);
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
