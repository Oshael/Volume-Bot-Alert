/**
 * Stage 76 - Custom-alert FDV metric and canonical spot window.
 * This migration changes storage capability only; it does not enable
 * Robinhood evaluation or delivery.
 * Run with: node src/utils/db-init-stage76.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE user_custom_alert_rules
     ADD COLUMN IF NOT EXISTS "window" VARCHAR(16) DEFAULT 'spot'`,
  `UPDATE user_custom_alert_rules
   SET "window" = 'spot'
   WHERE "window" IS NULL OR BTRIM("window") = ''`,
  `ALTER TABLE user_custom_alert_rules
     ALTER COLUMN "window" SET DEFAULT 'spot',
     ALTER COLUMN "window" SET NOT NULL`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'user_custom_alert_rules'::regclass
         AND conname = 'user_custom_alert_rules_metric_check'
         AND pg_get_constraintdef(oid) ILIKE '%price%'
         AND pg_get_constraintdef(oid) ILIKE '%mcap%'
         AND pg_get_constraintdef(oid) ILIKE '%fdv%'
     ) THEN
       ALTER TABLE user_custom_alert_rules
         DROP CONSTRAINT IF EXISTS user_custom_alert_rules_metric_check;
       ALTER TABLE user_custom_alert_rules
         ADD CONSTRAINT user_custom_alert_rules_metric_check
         CHECK (metric IN ('price', 'mcap', 'fdv'));
     END IF;
   END
   $migration$`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'user_custom_alert_rules'::regclass
         AND conname = 'user_custom_alert_rules_window_check'
         AND pg_get_constraintdef(oid) ILIKE '%spot%'
     ) THEN
       ALTER TABLE user_custom_alert_rules
         DROP CONSTRAINT IF EXISTS user_custom_alert_rules_window_check;
       ALTER TABLE user_custom_alert_rules
         ADD CONSTRAINT user_custom_alert_rules_window_check
         CHECK ("window" IN ('spot'));
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 76 custom-alert FDV and spot window applied successfully');
  } catch (error) {
    console.error('Failed to apply Stage 76 custom-alert capability schema:', error.message);
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
