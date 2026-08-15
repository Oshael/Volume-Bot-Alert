/** Stage 138 - durable non-edge kind for Robinhood wallet self-transfers. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `DO $constraint$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'rh_token_transfer_events_kind_check'
         AND pg_get_constraintdef(oid) ILIKE '%wallet_self%'
         AND pg_get_constraintdef(oid) ILIKE '%from_wallet%'
         AND pg_get_constraintdef(oid) ILIKE '%to_wallet%'
     ) THEN
       ALTER TABLE robinhood_token_transfer_events
         DROP CONSTRAINT IF EXISTS rh_token_transfer_events_kind_check;
       ALTER TABLE robinhood_token_transfer_events
         ADD CONSTRAINT rh_token_transfer_events_kind_check CHECK (transfer_kind IN (
           'unclassified', 'mint', 'burn', 'dex_flow', 'liquidity_flow',
           'router_flow', 'wallet_transfer', 'wallet_self', 'contract_flow', 'unknown'
         ) AND (transfer_kind <> 'wallet_self' OR from_wallet = to_wallet)
           AND (transfer_kind <> 'wallet_transfer' OR from_wallet <> to_wallet)
         ) NOT VALID;
     END IF;
   END
   $constraint$`,
  `UPDATE robinhood_token_transfer_events
     SET transfer_kind = 'wallet_self'
     WHERE transfer_kind = 'wallet_transfer'
       AND classification_version = 'rh_transfer_v1'
       AND from_wallet = to_wallet`,
  `ALTER TABLE robinhood_token_transfer_events
     VALIDATE CONSTRAINT rh_token_transfer_events_kind_check`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 138 Robinhood wallet self-transfer kind created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 138:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
