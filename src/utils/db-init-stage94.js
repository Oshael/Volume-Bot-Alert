/**
 * Stage 94 - Durable Telegram access reactivation epoch.
 * Retains the baseline boundary after a suspended connection becomes active.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE telegram_connections
     ADD COLUMN IF NOT EXISTS access_reactivated_at TIMESTAMPTZ`,
  `UPDATE telegram_connections
   SET access_reactivation_requested_at = date_trunc(
     'milliseconds', access_reactivation_requested_at
   )
   WHERE access_reactivation_requested_at IS NOT NULL`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'telegram_connections_reactivated_check'
         AND conrelid = 'telegram_connections'::regclass
     ) THEN
       ALTER TABLE telegram_connections
         ADD CONSTRAINT telegram_connections_reactivated_check
         CHECK (access_reactivated_at IS NULL OR status <> 'disconnected');
     END IF;
   END
   $$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 94 Telegram access reactivation epoch created successfully');
  } catch (error) {
    console.error('Failed to create Stage 94 Telegram reactivation epoch:', error.message);
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
