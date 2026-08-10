/** Stage 114 - explicit launchpad-event creator provenance. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_token_attributions
     ADD COLUMN IF NOT EXISTS attribution_factory_address VARCHAR(42)`,
  `DO $migration$
   BEGIN
     ALTER TABLE robinhood_token_attributions
       DROP CONSTRAINT IF EXISTS robinhood_token_attributions_source_check;
     ALTER TABLE robinhood_token_attributions
       ADD CONSTRAINT robinhood_token_attributions_source_check
       CHECK (source IN ('blockscout', 'rpc_direct', 'launchpad_event'));
     ALTER TABLE robinhood_token_attributions
       DROP CONSTRAINT IF EXISTS robinhood_token_attributions_provenance_check;
     ALTER TABLE robinhood_token_attributions
       ADD CONSTRAINT robinhood_token_attributions_provenance_check CHECK (
         (source = 'blockscout' AND attribution_block IS NULL
          AND attribution_tx_hash IS NULL AND attribution_factory_address IS NULL)
         OR (source = 'rpc_direct' AND attribution_block >= 0
             AND attribution_tx_hash ~ '^0x[0-9a-f]{64}$'
             AND attribution_factory_address IS NULL)
         OR (source = 'launchpad_event' AND attribution_block >= 0
             AND attribution_tx_hash ~ '^0x[0-9a-f]{64}$'
             AND attribution_factory_address ~ '^0x[0-9a-f]{40}$')
       );
   END
   $migration$`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 114 Robinhood launchpad creator provenance created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 114:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
