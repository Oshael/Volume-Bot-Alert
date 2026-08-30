'use strict';

/** Stage 183 - pruned-RPC deployment block evidence for live Robinhood holders. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `DO $migration$
   BEGIN
     PERFORM set_config('lock_timeout', '2s', true);
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'robinhood_token_attributions'::regclass
          AND conname = 'robinhood_token_attributions_source_check'
          AND pg_get_constraintdef(oid) LIKE '%rpc_code_transition%'
     ) THEN
       ALTER TABLE robinhood_token_attributions
         DROP CONSTRAINT IF EXISTS robinhood_token_attributions_source_check;
       ALTER TABLE robinhood_token_attributions
         ADD CONSTRAINT robinhood_token_attributions_source_check
         CHECK (source IN (
           'blockscout', 'blockscout_internal', 'rpc_code_transition',
           'rpc_direct', 'rpc_trace', 'launchpad_event'
         )) NOT VALID;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'robinhood_token_attributions'::regclass
          AND conname = 'robinhood_token_attributions_provenance_check'
          AND pg_get_constraintdef(oid) LIKE '%rpc_code_transition%'
     ) THEN
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
         ) NOT VALID;
     END IF;
   END
   $migration$`,
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
