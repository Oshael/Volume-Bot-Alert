/** Stage 111 - durable Robinhood token holder summaries from Blockscout. */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_token_holder_summaries (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     holder_count BIGINT,
     source VARCHAR(32) NOT NULL DEFAULT 'blockscout',
     observed_at TIMESTAMPTZ,
     checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error_code VARCHAR(64),
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     retry_after_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_token_holder_summaries_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT robinhood_token_holder_summaries_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_token_holder_summaries_token_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
     ),
     CONSTRAINT robinhood_token_holder_summaries_count_check CHECK (
       holder_count IS NULL OR holder_count >= 0
     ),
     CONSTRAINT robinhood_token_holder_summaries_source_check CHECK (source IN ('blockscout')),
     CONSTRAINT robinhood_token_holder_summaries_failures_check CHECK (consecutive_failures >= 0)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_token_holder_summaries_refresh
     ON robinhood_token_holder_summaries(
       retry_after_at ASC NULLS FIRST, checked_at ASC, token_address ASC
     )`,
];

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 111 Robinhood token holder summaries created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 111:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
