/** Stage 112 - daily Robinhood holder-count snapshots for historical charts. */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_token_holder_daily_snapshots (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     snapshot_date DATE NOT NULL,
     holder_count BIGINT NOT NULL,
     source VARCHAR(32) NOT NULL DEFAULT 'blockscout',
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_token_holder_daily_snapshots_pkey
       PRIMARY KEY (chain, token_address, snapshot_date),
     CONSTRAINT robinhood_token_holder_daily_snapshots_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_token_holder_daily_snapshots_token_check
       CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT robinhood_token_holder_daily_snapshots_count_check
       CHECK (holder_count >= 0),
     CONSTRAINT robinhood_token_holder_daily_snapshots_source_check
       CHECK (source IN ('blockscout'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_token_holder_daily_history
     ON robinhood_token_holder_daily_snapshots(
       token_address, snapshot_date DESC
     )`,
];

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 112 Robinhood daily holder snapshots created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 112:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
