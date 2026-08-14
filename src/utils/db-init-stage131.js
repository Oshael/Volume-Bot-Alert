/** Stage 131 - durable daily summaries for Robinhood transfer reconciliation. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_daily_summaries (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL,
     summary_day DATE NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     transfer_count BIGINT NOT NULL,
     total_amount_raw NUMERIC(78,0) NOT NULL,
     wallet_transfer_count BIGINT NOT NULL,
     wallet_transfer_amount_raw NUMERIC(78,0) NOT NULL,
     dex_flow_count BIGINT NOT NULL,
     dex_flow_amount_raw NUMERIC(78,0) NOT NULL,
     through_block BIGINT NOT NULL,
     through_transaction_index INTEGER NOT NULL,
     through_log_index INTEGER NOT NULL,
     through_block_time TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_daily_summaries_pkey PRIMARY KEY (
       chain, projection_version, summary_day, token_address
     ),
     CONSTRAINT rh_wallet_transfer_daily_summaries_chain_check CHECK (
       chain = 'robinhood'
     ),
     CONSTRAINT rh_wallet_transfer_daily_summaries_version_check CHECK (
       projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_wallet_transfer_daily_summaries_token_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_wallet_transfer_daily_summaries_totals_check CHECK (
       transfer_count > 0
       AND total_amount_raw >= 0
       AND wallet_transfer_count >= 0
       AND wallet_transfer_amount_raw >= 0
       AND dex_flow_count >= 0
       AND dex_flow_amount_raw >= 0
       AND wallet_transfer_count + dex_flow_count = transfer_count
       AND wallet_transfer_amount_raw + dex_flow_amount_raw = total_amount_raw
     ),
     CONSTRAINT rh_wallet_transfer_daily_summaries_frontier_check CHECK (
       through_block >= 0
       AND through_transaction_index >= 0
       AND through_log_index >= 0
       AND (through_block_time AT TIME ZONE 'UTC')::date = summary_day
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_daily_summaries_day
     ON robinhood_wallet_transfer_daily_summaries(
       chain, summary_day, projection_version
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 131 Robinhood transfer daily summaries created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 131:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
