/** Stage 143 - versioned Robinhood holder classifications and per-token frontiers. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_holder_classifications (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     tag VARCHAR(16) NOT NULL,
     classification_version VARCHAR(32) NOT NULL,
     confidence VARCHAR(16) NOT NULL,
     reason_code VARCHAR(64) NOT NULL,
     evidence_json JSONB NOT NULL,
     through_block_number BIGINT NOT NULL,
     through_block_hash VARCHAR(66) NOT NULL,
     observed_at TIMESTAMPTZ NOT NULL,
     expires_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_classifications_pkey PRIMARY KEY (
       chain, token_address, wallet_address, tag, classification_version
     ),
     CONSTRAINT rh_holder_classifications_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_classifications_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
       AND wallet_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_holder_classifications_version_check CHECK (
       classification_version ~ '^rh_holder_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_holder_classifications_confidence_check CHECK (
       confidence IN ('deterministic', 'high', 'heuristic')
       AND (tag NOT IN ('lp', 'cex') OR confidence = 'deterministic')
     ),
     CONSTRAINT rh_holder_classifications_reason_check CHECK (
       (tag = 'lp' AND reason_code IN (
         'registered_token_pool', 'registered_v4_pool_manager'
       ))
       OR (tag = 'cex' AND reason_code = 'known_cex_address')
       OR (tag = 'sniper' AND reason_code = 'early_launch_buy')
       OR (tag = 'fresh' AND reason_code = 'new_wallet_at_first_buy')
       OR (tag = 'insider' AND reason_code IN (
         'creator_token_distribution', 'creator_direct_funding'
       ))
     ),
     CONSTRAINT rh_holder_classifications_evidence_check CHECK (
       jsonb_typeof(evidence_json) = 'object' AND evidence_json <> '{}'::jsonb
     ),
     CONSTRAINT rh_holder_classifications_frontier_check CHECK (
       through_block_number >= 0
       AND through_block_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_holder_classifications_expiry_check CHECK (
       expires_at IS NULL OR expires_at > observed_at
     )
   )`,
  `ALTER TABLE robinhood_holder_classifications
     DROP CONSTRAINT IF EXISTS rh_holder_classifications_reason_check,
     ADD CONSTRAINT rh_holder_classifications_reason_check CHECK (
       (tag = 'lp' AND reason_code IN (
         'registered_token_pool', 'registered_v4_pool_manager'
       ))
       OR (tag = 'cex' AND reason_code = 'known_cex_address')
       OR (tag = 'sniper' AND reason_code = 'early_launch_buy')
       OR (tag = 'fresh' AND reason_code = 'new_wallet_at_first_buy')
       OR (tag = 'insider' AND reason_code IN (
         'creator_token_distribution', 'creator_direct_funding'
       ))
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_classifications_token_tag
     ON robinhood_holder_classifications(
       chain, token_address, classification_version, tag, wallet_address
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_holder_classification_states (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     classifier VARCHAR(16) NOT NULL,
     classification_version VARCHAR(32) NOT NULL,
     status VARCHAR(16) NOT NULL,
     status_reason VARCHAR(64) NOT NULL,
     through_block_number BIGINT,
     through_block_hash VARCHAR(66),
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_classification_states_pkey PRIMARY KEY (
       chain, token_address, classifier, classification_version
     ),
     CONSTRAINT rh_holder_classification_states_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_classification_states_token_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_holder_classification_states_classifier_check CHECK (
       classifier IN ('lp', 'cex', 'sniper', 'fresh', 'insider')
     ),
     CONSTRAINT rh_holder_classification_states_version_check CHECK (
       classification_version ~ '^rh_holder_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_holder_classification_states_status_check CHECK (
       status IN ('unavailable', 'pending', 'ready', 'stale', 'reorged')
       AND status_reason ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_holder_classification_states_frontier_pair_check CHECK (
       (through_block_number IS NULL) = (through_block_hash IS NULL)
     ),
     CONSTRAINT rh_holder_classification_states_frontier_value_check CHECK (
       (through_block_number IS NULL OR through_block_number >= 0)
       AND (through_block_hash IS NULL OR through_block_hash ~ '^0x[0-9a-f]{64}$')
     ),
     CONSTRAINT rh_holder_classification_states_status_frontier_check CHECK (
       (status IN ('ready', 'stale', 'reorged')) = (through_block_number IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_classification_states_status
     ON robinhood_holder_classification_states(
       chain, classification_version, status, classifier, token_address
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 143 Robinhood holder classification schema created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 143:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
