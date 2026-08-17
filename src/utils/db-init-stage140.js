/** Stage 140 - hourly Robinhood holder-count observations. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_token_holder_buckets (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     bucket_start TIMESTAMPTZ NOT NULL,
     holder_count BIGINT NOT NULL,
     source VARCHAR(32) NOT NULL,
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_token_holder_buckets_pkey
       PRIMARY KEY (chain, token_address, bucket_start),
     CONSTRAINT robinhood_token_holder_buckets_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_token_holder_buckets_token_check
       CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT robinhood_token_holder_buckets_count_check
       CHECK (holder_count >= 0),
     CONSTRAINT robinhood_token_holder_buckets_source_check
       CHECK (source IN ('blockscout', 'ledger_live')),
     CONSTRAINT robinhood_token_holder_buckets_hour_check CHECK (
       bucket_start = (
         date_trunc('hour', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       )
     )
   )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 140 Robinhood hourly holder buckets created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 140:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
