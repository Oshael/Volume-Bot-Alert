'use strict';

/** Stage 165 - durable live deployment resolution for new Robinhood catalog tokens. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_token_deployment_outbox (
     chain VARCHAR(32) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     last_error VARCHAR(500),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_token_deployment_outbox_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT rh_token_deployment_outbox_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_token_deployment_outbox_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_token_deployment_outbox_status_check CHECK (status IN ('pending', 'leased')),
     CONSTRAINT rh_token_deployment_outbox_attempt_check CHECK (attempt_count >= 0),
     CONSTRAINT rh_token_deployment_outbox_lease_check CHECK (
       (status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL)
       OR (status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_token_deployment_outbox_claim
     ON robinhood_token_deployment_outbox(status, next_attempt_at, created_at)`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_token_deployment()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     IF NEW.chain = 'robinhood' THEN
       INSERT INTO robinhood_token_deployment_outbox (chain, token_address)
       VALUES ('robinhood', NEW.address)
       ON CONFLICT (chain, token_address) DO NOTHING;
       PERFORM pg_notify('robinhood_token_deployment_outbox', NEW.address);
     END IF;
     RETURN NEW;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS token_catalog_robinhood_deployment_outbox ON token_catalog`,
  `CREATE TRIGGER token_catalog_robinhood_deployment_outbox
     AFTER INSERT ON token_catalog
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_token_deployment()`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 165 Robinhood token deployment outbox created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 165:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
