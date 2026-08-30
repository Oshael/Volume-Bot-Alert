'use strict';

/** Stage 183 - pruned-RPC deployment block evidence for live Robinhood holders. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `DO $migration$
   BEGIN
     ALTER TABLE robinhood_token_attributions
       DROP CONSTRAINT IF EXISTS robinhood_token_attributions_source_check;
     ALTER TABLE robinhood_token_attributions
       ADD CONSTRAINT robinhood_token_attributions_source_check
       CHECK (source IN (
         'blockscout', 'blockscout_internal', 'rpc_code_transition',
         'rpc_direct', 'rpc_trace', 'launchpad_event'
       ));
     ALTER TABLE robinhood_token_attributions
       DROP CONSTRAINT IF EXISTS robinhood_token_attributions_provenance_check;
     ALTER TABLE robinhood_token_attributions
       ADD CONSTRAINT robinhood_token_attributions_provenance_check CHECK (
         (source = 'blockscout' AND attribution_block IS NULL
          AND attribution_tx_hash IS NULL AND attribution_factory_address IS NULL)
         OR (source = 'rpc_code_transition' AND attribution_block IS NOT NULL
             AND attribution_block >= 0 AND creator_address IS NULL
             AND attribution_tx_hash IS NULL AND attribution_factory_address IS NULL)
         OR (source = 'rpc_direct' AND attribution_block IS NOT NULL
             AND attribution_block >= 0 AND attribution_tx_hash IS NOT NULL
             AND attribution_tx_hash ~ '^0x[0-9a-f]{64}$'
             AND attribution_factory_address IS NULL)
         OR (source IN ('blockscout_internal', 'rpc_trace', 'launchpad_event')
             AND attribution_block IS NOT NULL AND attribution_block >= 0
             AND attribution_tx_hash IS NOT NULL
             AND attribution_tx_hash ~ '^0x[0-9a-f]{64}$'
             AND attribution_factory_address IS NOT NULL
             AND attribution_factory_address ~ '^0x[0-9a-f]{40}$')
       );
   END
   $migration$`,
  `CREATE OR REPLACE FUNCTION wake_robinhood_token_deployment_from_mint()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   BEGIN
     PERFORM pg_notify('robinhood_token_deployment_outbox', minted.token_address)
       FROM (
         SELECT DISTINCT token_address FROM inserted_holder_transfers
          WHERE from_wallet = '0x0000000000000000000000000000000000000000'
       ) minted
      WHERE EXISTS (
        SELECT 1 FROM robinhood_token_deployment_outbox outbox
         WHERE outbox.chain = 'robinhood' AND outbox.token_address = minted.token_address
      );
     RETURN NULL;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_holder_journal_deployment_wake
     ON robinhood_holder_transfer_journal`,
  `CREATE TRIGGER rh_holder_journal_deployment_wake
     AFTER INSERT ON robinhood_holder_transfer_journal
     REFERENCING NEW TABLE AS inserted_holder_transfers
     FOR EACH STATEMENT EXECUTE FUNCTION wake_robinhood_token_deployment_from_mint()`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 183 Robinhood pruned-RPC deployment evidence created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 183:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
