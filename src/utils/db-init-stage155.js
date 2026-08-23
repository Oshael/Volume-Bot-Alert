/** Stage 155 - durable lazy cache for Robinhood token launch anchors. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_token_launch_anchors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     first_pool_block BIGINT NOT NULL,
     launch_block BIGINT NOT NULL,
     source_through_block BIGINT NOT NULL,
     evidence_version VARCHAR(32) NOT NULL DEFAULT 'rh_launch_anchor_v1',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_token_launch_anchors_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT rh_token_launch_anchors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_token_launch_anchors_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_token_launch_anchors_blocks_check CHECK (
       first_pool_block >= 0 AND launch_block >= first_pool_block
       AND source_through_block >= launch_block
     ),
     CONSTRAINT rh_token_launch_anchors_evidence_check CHECK (
       evidence_version ~ '^rh_launch_anchor_v[1-9][0-9]*$'
     )
   )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 155 Robinhood token launch-anchor cache created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 155:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
