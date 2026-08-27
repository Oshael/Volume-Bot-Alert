/** Stage 168 - versioned possible-bundle shadow snapshots. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_possible_bundle_states (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL,
     evidence_version VARCHAR(64) NOT NULL,
     status VARCHAR(16) NOT NULL,
     status_reason VARCHAR(64) NOT NULL,
     source_kind VARCHAR(16),
     source_run_id BIGINT REFERENCES robinhood_bundle_funding_backfill_runs(id)
       ON DELETE RESTRICT,
     lookback_blocks BIGINT NOT NULL,
     minimum_value_wei NUMERIC(78,0) NOT NULL,
     through_block_number BIGINT,
     through_block_hash VARCHAR(66),
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_possible_bundle_states_pkey PRIMARY KEY (
       chain, token_address, rule_version
     ),
     CONSTRAINT rh_possible_bundle_states_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_possible_bundle_states_token_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_possible_bundle_states_version_check CHECK (
       rule_version ~ '^rh_possible_bundle_v[1-9][0-9]*$'
       AND evidence_version ~ '^rh_native_funding_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_possible_bundle_states_status_check CHECK (
       status IN ('unavailable', 'pending', 'ready', 'stale', 'reorged')
       AND status_reason ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_possible_bundle_states_source_check CHECK (
       (source_kind IS NULL AND source_run_id IS NULL)
       OR (source_kind = 'seed' AND source_run_id IS NOT NULL)
       OR (source_kind = 'live' AND source_run_id IS NULL)
     ),
     CONSTRAINT rh_possible_bundle_states_policy_check CHECK (
       lookback_blocks > 0 AND minimum_value_wei > 0
     ),
     CONSTRAINT rh_possible_bundle_states_frontier_check CHECK (
       (through_block_number IS NULL) = (through_block_hash IS NULL)
       AND (through_block_number IS NULL OR through_block_number >= 0)
       AND (through_block_hash IS NULL OR through_block_hash ~ '^0x[0-9a-f]{64}$')
       AND ((status IN ('ready', 'stale', 'reorged')) =
         (through_block_number IS NOT NULL))
       AND (status NOT IN ('ready', 'stale', 'reorged') OR source_kind IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_possible_bundle_states_status
     ON robinhood_possible_bundle_states(
       chain, rule_version, status, token_address
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_possible_bundle_groups (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL,
     bundle_id VARCHAR(66) NOT NULL,
     member_count INTEGER NOT NULL,
     connection_count INTEGER NOT NULL,
     qualifying_value_wei NUMERIC(78,0) NOT NULL,
     evidence_json JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_possible_bundle_groups_pkey PRIMARY KEY (
       chain, token_address, rule_version, bundle_id
     ),
     CONSTRAINT rh_possible_bundle_groups_state_fkey FOREIGN KEY (
       chain, token_address, rule_version
     ) REFERENCES robinhood_possible_bundle_states(
       chain, token_address, rule_version
     ) ON DELETE CASCADE,
     CONSTRAINT rh_possible_bundle_groups_id_check CHECK (
       bundle_id ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_possible_bundle_groups_counts_check CHECK (
       member_count >= 2 AND connection_count >= 1 AND qualifying_value_wei > 0
     ),
     CONSTRAINT rh_possible_bundle_groups_evidence_check CHECK (
       jsonb_typeof(evidence_json) = 'object' AND evidence_json <> '{}'::jsonb
     )
   )`,
  `CREATE TABLE IF NOT EXISTS robinhood_possible_bundle_members (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL,
     bundle_id VARCHAR(66) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     launch_block BIGINT NOT NULL,
     first_buy_block BIGINT NOT NULL,
     first_buy_transaction_index INTEGER NOT NULL,
     connection_kind VARCHAR(32) NOT NULL,
     evidence_json JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_possible_bundle_members_pkey PRIMARY KEY (
       chain, token_address, rule_version, wallet_address
     ),
     CONSTRAINT rh_possible_bundle_members_group_fkey FOREIGN KEY (
       chain, token_address, rule_version, bundle_id
     ) REFERENCES robinhood_possible_bundle_groups(
       chain, token_address, rule_version, bundle_id
     ) ON DELETE CASCADE,
     CONSTRAINT rh_possible_bundle_members_address_check CHECK (
       wallet_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_possible_bundle_members_position_check CHECK (
       launch_block >= 0 AND first_buy_block BETWEEN launch_block AND launch_block + 3
       AND first_buy_transaction_index >= 0
     ),
     CONSTRAINT rh_possible_bundle_members_connection_check CHECK (
       connection_kind IN (
         'direct_member_funding', 'connected_funding_ancestor', 'mixed'
       )
     ),
     CONSTRAINT rh_possible_bundle_members_evidence_check CHECK (
       jsonb_typeof(evidence_json) = 'object' AND evidence_json <> '{}'::jsonb
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_possible_bundle_members_group
     ON robinhood_possible_bundle_members(
       chain, token_address, rule_version, bundle_id, wallet_address
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_possible_bundle_members_wallet
     ON robinhood_possible_bundle_members(chain, wallet_address, rule_version)`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 168 Robinhood possible-bundle snapshots created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 168:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
