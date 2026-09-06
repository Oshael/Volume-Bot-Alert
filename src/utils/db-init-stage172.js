/** Stage 172 - token-scoped VPS queue for live BUNDLED Archive funding work. */
const db = require('../models/db');

const ENQUEUE_FUNCTION_STATEMENT = `CREATE OR REPLACE FUNCTION enqueue_robinhood_bundle_funding_live()
 RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
 BEGIN
   INSERT INTO robinhood_bundle_funding_live_queue(
     token_address, anchor_block, source_through_block
   ) VALUES (NEW.token_address, NEW.launch_block, NEW.source_through_block)
   ON CONFLICT (chain, token_address) DO UPDATE SET
     anchor_block = EXCLUDED.anchor_block,
     source_through_block = GREATEST(
       robinhood_bundle_funding_live_queue.source_through_block,
       EXCLUDED.source_through_block
     ),
     requested_version = robinhood_bundle_funding_live_queue.requested_version + 1,
     status = 'pending', lease_owner = NULL, lease_until = NULL,
     next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
     completed_at = NULL, updated_at = NOW()
   WHERE robinhood_bundle_funding_live_queue.status <> 'complete'
      OR robinhood_bundle_funding_live_queue.last_error_code
           IS DISTINCT FROM 'archive_required'
      OR robinhood_bundle_funding_live_queue.anchor_block <> EXCLUDED.anchor_block;
   PERFORM pg_notify('robinhood_bundle_funding_live_queue', NEW.token_address);
   RETURN NEW;
 END
 $trigger$`;

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_funding_live_queue (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL DEFAULT 'rh_possible_bundle_v1',
     evidence_version VARCHAR(64) NOT NULL DEFAULT 'rh_native_funding_v2',
     lookback_blocks BIGINT NOT NULL DEFAULT 1000,
     anchor_block BIGINT NOT NULL,
     source_through_block BIGINT NOT NULL,
     requested_version BIGINT NOT NULL DEFAULT 1,
     completed_version BIGINT NOT NULL DEFAULT 0,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_funding_live_queue_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT rh_bundle_funding_live_queue_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_bundle_funding_live_queue_version_check CHECK (
       rule_version = 'rh_possible_bundle_v1'
       AND evidence_version = 'rh_native_funding_v2'
       AND requested_version >= 1
       AND completed_version BETWEEN 0 AND requested_version
     ),
     CONSTRAINT rh_bundle_funding_live_queue_bounds_check CHECK (
       lookback_blocks = 1000 AND anchor_block >= 0
       AND source_through_block >= anchor_block AND attempt_count >= 0
     ),
     CONSTRAINT rh_bundle_funding_live_queue_lifecycle_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
       AND (status = 'complete') = (completed_at IS NOT NULL)
       AND (status <> 'complete' OR completed_version = requested_version)
       AND status IN ('pending', 'leased', 'complete')
       AND (last_error_code IS NULL) = (last_error_message IS NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_live_queue_claim
     ON robinhood_bundle_funding_live_queue(next_attempt_at, updated_at)
     WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_live_queue_lease
     ON robinhood_bundle_funding_live_queue(lease_until)
     WHERE status = 'leased'`,
  ENQUEUE_FUNCTION_STATEMENT,
  `DROP TRIGGER IF EXISTS rh_launch_anchor_bundle_funding_live
     ON robinhood_token_launch_anchors`,
  `CREATE TRIGGER rh_launch_anchor_bundle_funding_live
     AFTER INSERT OR UPDATE ON robinhood_token_launch_anchors
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_bundle_funding_live()`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 172 Robinhood BUNDLED live funding queue created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 172:', error.message);
  process.exitCode = 1;
});

module.exports = { ENQUEUE_FUNCTION_STATEMENT, STATEMENTS, init };
