/**
 * Stage 77 - Chain-scoped alert cursors and persistent event dismissals.
 * Existing combined custom-alert cursors are copied to Robinhood so the
 * migration does not replay alerts that the user already cleared.
 * Run with: node src/utils/db-init-stage77.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `DO $migration$
   DECLARE
     primary_key_name TEXT;
     primary_key_definition TEXT;
   BEGIN
     ALTER TABLE alert_delivery_cursors
       ADD COLUMN IF NOT EXISTS chain VARCHAR(32) DEFAULT 'solana';

     UPDATE alert_delivery_cursors
     SET chain = CASE
       WHEN rule_key = 'robinhood-hvnc-v2' THEN 'robinhood'
       ELSE 'solana'
     END
     WHERE chain IS NULL
        OR chain NOT IN ('solana', 'ethereum', 'bsc', 'base', 'robinhood');

     UPDATE alert_delivery_cursors
     SET chain = 'robinhood'
     WHERE rule_key = 'robinhood-hvnc-v2'
       AND chain = 'solana';

     ALTER TABLE alert_delivery_cursors
       ALTER COLUMN chain SET DEFAULT 'solana',
       ALTER COLUMN chain SET NOT NULL;

     SELECT conname, pg_get_constraintdef(oid)
     INTO primary_key_name, primary_key_definition
     FROM pg_constraint
     WHERE conrelid = 'alert_delivery_cursors'::regclass
       AND contype = 'p'
     LIMIT 1;

     IF primary_key_name IS NOT NULL
        AND primary_key_definition NOT ILIKE '%chain%' THEN
       EXECUTE format(
         'ALTER TABLE alert_delivery_cursors DROP CONSTRAINT %I',
         primary_key_name
       );
       primary_key_name := NULL;
     END IF;

     INSERT INTO alert_delivery_cursors (
       user_id,
       rule_key,
       chain,
       last_seen_event_id,
       last_acked_event_id,
       updated_at
     )
     SELECT
       source.user_id,
       source.rule_key,
       'robinhood',
       source.last_seen_event_id,
       source.last_acked_event_id,
       source.updated_at
     FROM alert_delivery_cursors source
     WHERE source.rule_key = 'custom-alert'
       AND source.chain = 'solana'
       AND NOT EXISTS (
         SELECT 1
         FROM alert_delivery_cursors target
         WHERE target.user_id = source.user_id
           AND target.rule_key = source.rule_key
           AND target.chain = 'robinhood'
       );

     IF primary_key_name IS NULL THEN
       ALTER TABLE alert_delivery_cursors
         ADD CONSTRAINT alert_delivery_cursors_pkey
         PRIMARY KEY (user_id, rule_key, chain);
     END IF;

     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'alert_delivery_cursors'::regclass
         AND conname = 'alert_delivery_cursors_chain_check'
     ) THEN
       ALTER TABLE alert_delivery_cursors
         ADD CONSTRAINT alert_delivery_cursors_chain_check
         CHECK (chain IN ('solana', 'ethereum', 'bsc', 'base', 'robinhood'));
     END IF;
   END
   $migration$`,
  `CREATE TABLE IF NOT EXISTS alert_event_dismissals (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     rule_key VARCHAR(64) NOT NULL,
     chain VARCHAR(32) NOT NULL,
     event_id BIGINT NOT NULL,
     dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT alert_event_dismissals_pkey
       PRIMARY KEY (user_id, rule_key, chain, event_id),
     CONSTRAINT alert_event_dismissals_chain_check
       CHECK (chain IN ('solana', 'ethereum', 'bsc', 'base', 'robinhood')),
     CONSTRAINT alert_event_dismissals_event_id_check
       CHECK (event_id > 0)
   )`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 77 chain-scoped alert state applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 77 alert state schema:', error.message);
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
