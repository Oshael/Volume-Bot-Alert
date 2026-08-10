/** Stage 113 - direct on-chain creator provenance and independent LIVE cursor. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_token_attributions
     ADD COLUMN IF NOT EXISTS attribution_block BIGINT,
     ADD COLUMN IF NOT EXISTS attribution_tx_hash VARCHAR(66)`,
  `DO $migration$
   BEGIN
     ALTER TABLE robinhood_token_attributions
       DROP CONSTRAINT IF EXISTS robinhood_token_attributions_source_check;
     ALTER TABLE robinhood_token_attributions
       ADD CONSTRAINT robinhood_token_attributions_source_check
       CHECK (source IN ('blockscout', 'rpc_direct'));
     ALTER TABLE robinhood_token_attributions
       DROP CONSTRAINT IF EXISTS robinhood_token_attributions_provenance_check;
     ALTER TABLE robinhood_token_attributions
       ADD CONSTRAINT robinhood_token_attributions_provenance_check CHECK (
         (source = 'blockscout' AND attribution_block IS NULL AND attribution_tx_hash IS NULL)
         OR (source = 'rpc_direct' AND attribution_block >= 0
             AND attribution_tx_hash ~ '^0x[0-9a-f]{64}$')
       );
   END
   $migration$`,
  `CREATE TABLE IF NOT EXISTS robinhood_direct_creator_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     stream VARCHAR(16) NOT NULL DEFAULT 'live',
     next_block BIGINT NOT NULL,
     safe_head BIGINT NOT NULL,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     checkpoint_timestamp TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_direct_creator_cursors_pkey PRIMARY KEY (chain, stream),
     CONSTRAINT robinhood_direct_creator_cursors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_direct_creator_cursors_stream_check CHECK (stream = 'live'),
     CONSTRAINT robinhood_direct_creator_cursors_blocks_check
       CHECK (next_block >= 0 AND safe_head >= 0),
     CONSTRAINT robinhood_direct_creator_cursors_checkpoint_pair_check
       CHECK ((checkpoint_block IS NULL) = (checkpoint_hash IS NULL)),
     CONSTRAINT robinhood_direct_creator_cursors_checkpoint_hash_check
       CHECK (checkpoint_hash IS NULL OR checkpoint_hash ~ '^0x[0-9a-f]{64}$')
   )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 113 Robinhood direct creator LIVE schema created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 113:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
