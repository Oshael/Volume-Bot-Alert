/** Stage 110 - token-level Robinhood creator attribution for the DEV feed scope. */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_token_attributions (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     creator_address VARCHAR(42),
     source VARCHAR(32) NOT NULL DEFAULT 'blockscout',
     last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_resolved_at TIMESTAMPTZ,
     last_error VARCHAR(500),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_token_attributions_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT robinhood_token_attributions_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_token_attributions_token_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT robinhood_token_attributions_creator_check CHECK (
       creator_address IS NULL OR creator_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT robinhood_token_attributions_source_check CHECK (source IN ('blockscout')),
     CONSTRAINT robinhood_token_attributions_resolution_check CHECK (
       (creator_address IS NULL AND last_resolved_at IS NULL)
       OR (creator_address IS NOT NULL AND last_resolved_at IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_token_attributions_retry
     ON robinhood_token_attributions(last_attempted_at ASC)
     WHERE creator_address IS NULL`,
];

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 110 Robinhood token attributions created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 110:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
