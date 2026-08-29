/** Stage 177 - eligibility-aware Robinhood launch-anchor outbox. */
const db = require('../models/db');

const VERSION = 'rh_holder_live_v1';
const ENQUEUE_SQL = `INSERT INTO robinhood_launch_anchor_outbox(
  chain, token_address, eligibility_version
) VALUES ('robinhood', NEW.token_address, '${VERSION}')
ON CONFLICT (chain, token_address) DO UPDATE SET
  eligibility_version = EXCLUDED.eligibility_version,
  status = 'pending', attempt_count = 0,
  lease_owner = NULL, lease_until = NULL,
  next_attempt_at = NOW(), last_error = NULL, updated_at = NOW();
PERFORM pg_notify('robinhood_launch_anchor_outbox', NEW.token_address);`;

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_launch_anchor_outbox
     ADD COLUMN IF NOT EXISTS eligibility_version VARCHAR(64)
       NOT NULL DEFAULT '${VERSION}',
     DROP CONSTRAINT IF EXISTS rh_launch_anchor_outbox_eligibility_check,
     ADD CONSTRAINT rh_launch_anchor_outbox_eligibility_check CHECK (
       eligibility_version = '${VERSION}'
     )`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_launch_anchor()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     PERFORM pg_advisory_xact_lock(
       hashtext('rh-launch-anchor'), hashtext(NEW.token_address)
     );
     IF EXISTS (
       SELECT 1 FROM robinhood_holder_token_states state
        WHERE state.chain = 'robinhood' AND state.token_address = NEW.token_address
          AND state.ledger_status = 'live' AND state.live_through_block IS NOT NULL
     ) THEN
       ${ENQUEUE_SQL}
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_launch_anchor_from_holder()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     IF NEW.chain <> 'robinhood' OR NEW.ledger_status <> 'live'
        OR NEW.live_through_block IS NULL THEN
       RETURN NEW;
     END IF;
     IF TG_OP = 'UPDATE' THEN
       IF OLD.ledger_status = 'live' AND OLD.live_through_block IS NOT NULL THEN
         RETURN NEW;
       END IF;
     END IF;
     PERFORM pg_advisory_xact_lock(
       hashtext('rh-launch-anchor'), hashtext(NEW.token_address)
     );
     IF EXISTS (
       SELECT 1 FROM robinhood_wallet_token_first_buys buy
        WHERE buy.chain = 'robinhood' AND buy.token_address = NEW.token_address
     ) THEN
       ${ENQUEUE_SQL}
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_holder_live_launch_anchor_outbox
     ON robinhood_holder_token_states`,
  `CREATE TRIGGER rh_holder_live_launch_anchor_outbox
     AFTER INSERT OR UPDATE OF ledger_status, live_through_block
     ON robinhood_holder_token_states
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_launch_anchor_from_holder()`,
  `DELETE FROM robinhood_launch_anchor_outbox outbox
    WHERE outbox.chain = 'robinhood' AND NOT EXISTS (
      SELECT 1 FROM robinhood_holder_token_states state
       WHERE state.chain = outbox.chain AND state.token_address = outbox.token_address
         AND state.ledger_status = 'live' AND state.live_through_block IS NOT NULL
    )`,
  `UPDATE robinhood_launch_anchor_outbox outbox SET
     eligibility_version = '${VERSION}', status = 'pending',
     lease_owner = NULL, lease_until = NULL, next_attempt_at = NOW(),
     last_error = NULL, updated_at = NOW()
    WHERE outbox.chain = 'robinhood'
      AND (outbox.status = 'pending' OR outbox.lease_until <= NOW())`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 177 Robinhood launch-anchor eligibility created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 177:', error.message);
  process.exitCode = 1;
});

module.exports = { ENQUEUE_SQL, STATEMENTS, VERSION, init };
