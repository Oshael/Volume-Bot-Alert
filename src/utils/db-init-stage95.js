/**
 * Stage 95 - Telegram user language preference.
 * Persists the latest valid Telegram language code for asynchronous localization.
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE telegram_connections
     ADD COLUMN IF NOT EXISTS language_code VARCHAR(35) NOT NULL DEFAULT 'en'`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'telegram_connections_language_code_check'
         AND conrelid = 'telegram_connections'::regclass
     ) THEN
       ALTER TABLE telegram_connections
         ADD CONSTRAINT telegram_connections_language_code_check
         CHECK (
           language_code = BTRIM(language_code)
           AND CHAR_LENGTH(language_code) BETWEEN 2 AND 35
         );
     END IF;
   END
   $$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 95 Telegram language preference created successfully');
  } catch (error) {
    console.error('Failed to create Stage 95 Telegram language preference:', error.message);
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
