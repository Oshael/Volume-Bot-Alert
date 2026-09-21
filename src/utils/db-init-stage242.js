'use strict';

/** Stage 242 - separate live deployment work from Archive-required recovery. */
const db = require('../models/db');

const TABLE = 'robinhood_token_deployment_outbox';

const STATEMENTS = Object.freeze([
  `ALTER TABLE ${TABLE}
     ADD COLUMN IF NOT EXISTS live_deadline_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS archive_required_at TIMESTAMPTZ`,
  `ALTER TABLE ${TABLE}
     ALTER COLUMN live_deadline_at SET DEFAULT (NOW() + INTERVAL '72 hours')`,
  `ALTER TABLE ${TABLE}
     DROP CONSTRAINT IF EXISTS rh_token_deployment_outbox_deadline_guard,
     ADD CONSTRAINT rh_token_deployment_outbox_deadline_guard
       CHECK (live_deadline_at IS NOT NULL) NOT VALID`,
  `UPDATE ${TABLE}
      SET live_deadline_at = created_at + INTERVAL '72 hours'
    WHERE live_deadline_at IS NULL`,
  `ALTER TABLE ${TABLE}
     VALIDATE CONSTRAINT rh_token_deployment_outbox_deadline_guard`,
  `ALTER TABLE ${TABLE}
     ALTER COLUMN live_deadline_at SET NOT NULL`,
  `ALTER TABLE ${TABLE}
     DROP CONSTRAINT IF EXISTS rh_token_deployment_outbox_deadline_guard`,
  `ALTER TABLE ${TABLE}
     DROP CONSTRAINT IF EXISTS rh_token_deployment_outbox_status_check,
     DROP CONSTRAINT IF EXISTS rh_token_deployment_outbox_lease_check,
     ADD CONSTRAINT rh_token_deployment_outbox_status_check CHECK (
       status IN ('pending', 'leased', 'archive_required')
     ),
     ADD CONSTRAINT rh_token_deployment_outbox_lease_check CHECK (
       (status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL
         AND archive_required_at IS NULL)
       OR (status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL
         AND archive_required_at IS NULL)
       OR (status = 'archive_required' AND lease_owner IS NULL AND lease_until IS NULL
         AND archive_required_at IS NOT NULL)
     )`,
  `UPDATE ${TABLE}
      SET status = 'archive_required', lease_owner = NULL, lease_until = NULL,
          archive_required_at = COALESCE(archive_required_at, NOW()), updated_at = NOW()
    WHERE live_deadline_at <= NOW()
      AND (status = 'pending' OR (status = 'leased' AND lease_until <= NOW()))`,
  `CREATE INDEX IF NOT EXISTS idx_rh_token_deployment_outbox_live_deadline
     ON ${TABLE}(status, live_deadline_at, next_attempt_at)
     WHERE status = 'pending'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 242 Robinhood deployment live/Archive lanes applied successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 242:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, TABLE, init };
