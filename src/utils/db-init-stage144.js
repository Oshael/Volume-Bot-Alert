/** Stage 144 - versioned Robinhood holder distribution metric snapshots. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_holder_distribution_metrics (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     metric VARCHAR(32) NOT NULL,
     classification_version VARCHAR(32) NOT NULL,
     status VARCHAR(16) NOT NULL,
     status_reason VARCHAR(64) NOT NULL,
     value_numerator_raw NUMERIC(78,0),
     value_denominator_raw NUMERIC(78,0),
     wallet_count BIGINT,
     group_count BIGINT,
     evidence_json JSONB NOT NULL,
     through_block_number BIGINT,
     through_block_hash VARCHAR(66),
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_distribution_metrics_pkey PRIMARY KEY (
       chain, token_address, metric, classification_version
     ),
     CONSTRAINT rh_holder_distribution_metrics_chain_check CHECK (
       chain = 'robinhood'
     ),
     CONSTRAINT rh_holder_distribution_metrics_token_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_holder_distribution_metrics_metric_check CHECK (
       metric IN (
         'top10', 'top50', 'snipers', 'fresh_wallets', 'insiders',
         'dev_hold', 'lp_locked', 'bundled'
       )
     ),
     CONSTRAINT rh_holder_distribution_metrics_version_check CHECK (
       classification_version ~ '^rh_holder_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_holder_distribution_metrics_status_check CHECK (
       status IN ('unavailable', 'pending', 'ready', 'stale', 'reorged')
       AND status_reason ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_holder_distribution_metrics_values_check CHECK (
       (value_numerator_raw IS NULL OR value_numerator_raw >= 0)
       AND (value_denominator_raw IS NULL OR value_denominator_raw > 0)
       AND (value_numerator_raw IS NULL OR value_denominator_raw IS NULL
         OR value_numerator_raw <= value_denominator_raw)
       AND (wallet_count IS NULL OR wallet_count >= 0)
       AND (group_count IS NULL OR group_count >= 0)
       AND (group_count IS NULL OR metric = 'bundled')
     ),
     CONSTRAINT rh_holder_distribution_metrics_evidence_check CHECK (
       jsonb_typeof(evidence_json) = 'object' AND evidence_json <> '{}'::jsonb
     ),
     CONSTRAINT rh_holder_distribution_metrics_frontier_pair_check CHECK (
       (through_block_number IS NULL) = (through_block_hash IS NULL)
     ),
     CONSTRAINT rh_holder_distribution_metrics_frontier_value_check CHECK (
       (through_block_number IS NULL OR through_block_number >= 0)
       AND (through_block_hash IS NULL
         OR through_block_hash ~ '^0x[0-9a-f]{64}$')
     ),
     CONSTRAINT rh_holder_distribution_metrics_status_frontier_check CHECK (
       (status IN ('ready', 'stale', 'reorged')) =
         (through_block_number IS NOT NULL)
     ),
     CONSTRAINT rh_holder_distribution_metrics_payload_check CHECK (
       (status IN ('unavailable', 'pending')
         AND value_numerator_raw IS NULL AND value_denominator_raw IS NULL
         AND wallet_count IS NULL AND group_count IS NULL)
       OR (status IN ('ready', 'stale', 'reorged') AND (
         (metric = 'bundled'
           AND value_numerator_raw IS NULL AND value_denominator_raw IS NULL
           AND wallet_count IS NOT NULL AND group_count IS NOT NULL)
         OR (metric <> 'bundled'
           AND value_numerator_raw IS NOT NULL AND value_denominator_raw IS NOT NULL
           AND group_count IS NULL)
       ))
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_distribution_metrics_status
     ON robinhood_holder_distribution_metrics(
       chain, classification_version, status, metric, token_address
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 144 Robinhood holder distribution metrics created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 144:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
