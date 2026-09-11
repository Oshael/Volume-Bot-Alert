'use strict';

/** Stage 209 - independent shadow-audit delivery state for Stage 204. */
const db = require('../models/db');

const TABLE = 'robinhood_wallet_swap_realtime_outbox';
const INDEX_NAMES = Object.freeze([
  'idx_rh_wallet_swap_realtime_outbox_audit_claim',
  'idx_rh_wallet_swap_realtime_outbox_audit_lease',
  'idx_rh_wallet_swap_realtime_outbox_audit_observed',
]);
const STATEMENTS = Object.freeze([
  `ALTER TABLE ${TABLE}
     ADD COLUMN IF NOT EXISTS audit_status VARCHAR(16) NOT NULL DEFAULT 'pending',
     ADD COLUMN IF NOT EXISTS audit_lease_owner VARCHAR(128),
     ADD COLUMN IF NOT EXISTS audit_lease_until TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS audit_attempt_count INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS audit_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS audit_last_error TEXT`,
  `DO $constraints$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid='${TABLE}'::regclass
         AND conname='rh_wallet_swap_realtime_outbox_audit_status_check') THEN
       ALTER TABLE ${TABLE} ADD CONSTRAINT
         rh_wallet_swap_realtime_outbox_audit_status_check CHECK (
           audit_status IN ('pending', 'leased', 'complete', 'blocked')
           AND audit_attempt_count >= 0
         ) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid='${TABLE}'::regclass
         AND conname='rh_wallet_swap_realtime_outbox_audit_lease_check') THEN
       ALTER TABLE ${TABLE} ADD CONSTRAINT
         rh_wallet_swap_realtime_outbox_audit_lease_check CHECK (
           (audit_status='leased') =
           (audit_lease_owner IS NOT NULL AND audit_lease_until IS NOT NULL)
         ) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid='${TABLE}'::regclass
         AND conname='rh_wallet_swap_realtime_outbox_audit_completion_check') THEN
       ALTER TABLE ${TABLE} ADD CONSTRAINT
         rh_wallet_swap_realtime_outbox_audit_completion_check CHECK (
           (audit_status='complete') = (audited_at IS NOT NULL)
         ) NOT VALID;
     END IF;
   END
   $constraints$`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_wallet_swap_realtime_outbox_audit_claim
     ON ${TABLE}(
       audit_next_attempt_at, block_number, transaction_index, log_index, event_kind
     ) WHERE audit_status='pending'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_wallet_swap_realtime_outbox_audit_lease
     ON ${TABLE}(audit_lease_until) WHERE audit_status='leased'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_wallet_swap_realtime_outbox_audit_observed
     ON ${TABLE}(chain, transaction_hash, log_index, block_hash)
     WHERE event_kind='observed' AND audit_status='complete'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const invalid = await database.query(
      `SELECT indexrelid::regclass::text AS name FROM pg_index
        WHERE indexrelid IN (
          SELECT to_regclass(name) FROM unnest($1::text[]) AS name
        ) AND NOT indisvalid`,
      [INDEX_NAMES]
    );
    for (const { name } of invalid.rows) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    }
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 209 Robinhood trade lifecycle shadow audit created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 209:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAMES, STATEMENTS, TABLE, init };
