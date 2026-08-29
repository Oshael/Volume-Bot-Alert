/** Stage 171 - durable live launch-anchor work emitted by committed first buys. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_launch_anchor_outbox (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     last_error VARCHAR(500),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_launch_anchor_outbox_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT rh_launch_anchor_outbox_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_launch_anchor_outbox_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT rh_launch_anchor_outbox_status_check CHECK (status IN ('pending', 'leased')),
     CONSTRAINT rh_launch_anchor_outbox_lease_check CHECK (
       (status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL)
       OR (status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_launch_anchor_outbox_claim
     ON robinhood_launch_anchor_outbox(next_attempt_at, created_at)`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_launch_anchor()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     INSERT INTO robinhood_launch_anchor_outbox(chain, token_address)
     VALUES ('robinhood', NEW.token_address)
     ON CONFLICT (chain, token_address) DO UPDATE SET
       status = 'pending', lease_owner = NULL, lease_until = NULL,
       next_attempt_at = NOW(), last_error = NULL, updated_at = NOW();
     PERFORM pg_notify('robinhood_launch_anchor_outbox', NEW.token_address);
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_first_buy_launch_anchor_outbox
     ON robinhood_wallet_token_first_buys`,
  `CREATE TRIGGER rh_first_buy_launch_anchor_outbox
     AFTER INSERT OR UPDATE ON robinhood_wallet_token_first_buys
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_launch_anchor()`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 171 Robinhood launch-anchor live outbox created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 171:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
