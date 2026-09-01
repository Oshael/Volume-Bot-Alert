'use strict';

/** Stage 187 - token-redistribution BUNDLED shadow snapshots. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_redistribution_states (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL,
     evidence_version VARCHAR(64) NOT NULL,
     status VARCHAR(16) NOT NULL,
     status_reason VARCHAR(64) NOT NULL,
     source_kind VARCHAR(16),
     source_run_id BIGINT,
     source_version BIGINT,
     through_block_number BIGINT,
     through_block_hash VARCHAR(66),
     policy_json JSONB NOT NULL,
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_redistribution_states_pkey PRIMARY KEY (
       chain, token_address, rule_version
     ),
     CONSTRAINT rh_bundle_redistribution_states_scope_check CHECK (
       chain = 'robinhood'
       AND token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
       AND rule_version ~ '^rh_possible_bundle_redistribution_v[1-9][0-9]*$'
       AND evidence_version ~ '^rh_token_redistribution_v[1-9][0-9]*$'
     ),
     CONSTRAINT rh_bundle_redistribution_states_status_check CHECK (
       status IN ('unavailable', 'pending', 'ready', 'stale', 'reorged')
       AND status_reason ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     ),
     CONSTRAINT rh_bundle_redistribution_states_source_check CHECK (
       (source_kind IS NULL AND source_run_id IS NULL AND source_version IS NULL)
       OR (source_kind = 'seed' AND source_run_id >= 1 AND source_version IS NULL)
       OR (source_kind = 'live' AND source_run_id IS NULL AND source_version >= 1)
     ),
     CONSTRAINT rh_bundle_redistribution_states_frontier_check CHECK (
       (through_block_number IS NULL) = (through_block_hash IS NULL)
       AND (through_block_number IS NULL OR through_block_number >= 0)
       AND (through_block_hash IS NULL OR through_block_hash ~ '^0x[0-9a-f]{64}$')
       AND ((status IN ('ready', 'stale', 'reorged')) =
         (through_block_number IS NOT NULL))
       AND (status NOT IN ('ready', 'stale', 'reorged') OR source_kind IS NOT NULL)
     ),
     CONSTRAINT rh_bundle_redistribution_states_policy_check CHECK (
       jsonb_typeof(policy_json) = 'object' AND policy_json <> '{}'::jsonb
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_redistribution_states_status
     ON robinhood_bundle_redistribution_states(
       chain, rule_version, status, token_address
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_redistribution_groups (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL,
     bundle_id VARCHAR(66) NOT NULL,
     source_wallet VARCHAR(42) NOT NULL,
     member_count INTEGER NOT NULL,
     connection_count INTEGER NOT NULL,
     confirmation_block BIGINT NOT NULL,
     confirmation_transaction_index INTEGER NOT NULL,
     confirmation_action_index INTEGER NOT NULL,
     confirmation_transaction_hash VARCHAR(66) NOT NULL,
     confirmation_fdv_usd NUMERIC,
     evidence_json JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_redistribution_groups_pkey PRIMARY KEY (
       chain, token_address, rule_version, bundle_id
     ),
     CONSTRAINT rh_bundle_redistribution_groups_state_fkey FOREIGN KEY (
       chain, token_address, rule_version
     ) REFERENCES robinhood_bundle_redistribution_states(
       chain, token_address, rule_version
     ) ON DELETE CASCADE,
     CONSTRAINT rh_bundle_redistribution_groups_identity_check CHECK (
       bundle_id ~ '^0x[0-9a-f]{64}$'
       AND source_wallet ~ '^0x[0-9a-f]{40}$'
       AND source_wallet <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_bundle_redistribution_groups_counts_check CHECK (
       member_count >= 3 AND connection_count >= 2
       AND member_count = connection_count + 1
     ),
     CONSTRAINT rh_bundle_redistribution_groups_confirmation_check CHECK (
       confirmation_block >= 0 AND confirmation_transaction_index >= 0
       AND confirmation_action_index >= 0
       AND confirmation_transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND (confirmation_fdv_usd IS NULL OR confirmation_fdv_usd >= 0)
     ),
     CONSTRAINT rh_bundle_redistribution_groups_evidence_check CHECK (
       jsonb_typeof(evidence_json) = 'object' AND evidence_json <> '{}'::jsonb
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_bundle_redistribution_groups_source
     ON robinhood_bundle_redistribution_groups(
       chain, token_address, rule_version, source_wallet
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_redistribution_members (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL,
     bundle_id VARCHAR(66) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     connection_kind VARCHAR(32) NOT NULL,
     source_buy_block BIGINT NOT NULL,
     source_buy_transaction_index INTEGER NOT NULL,
     source_buy_action_index INTEGER NOT NULL,
     source_buy_transaction_hash VARCHAR(66) NOT NULL,
     transfer_block BIGINT,
     transfer_transaction_index INTEGER,
     transfer_log_index INTEGER,
     transfer_transaction_hash VARCHAR(66),
     transfer_amount_raw NUMERIC(78,0),
     sell_block BIGINT,
     sell_transaction_index INTEGER,
     sell_action_index INTEGER,
     sell_transaction_hash VARCHAR(66),
     sell_delay_ms INTEGER,
     evidence_json JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_redistribution_members_pkey PRIMARY KEY (
       chain, token_address, rule_version, bundle_id, wallet_address
     ),
     CONSTRAINT rh_bundle_redistribution_members_group_fkey FOREIGN KEY (
       chain, token_address, rule_version, bundle_id
     ) REFERENCES robinhood_bundle_redistribution_groups(
       chain, token_address, rule_version, bundle_id
     ) ON DELETE CASCADE,
     CONSTRAINT rh_bundle_redistribution_members_address_check CHECK (
       wallet_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_bundle_redistribution_members_buy_check CHECK (
       source_buy_block >= 0 AND source_buy_transaction_index >= 0
       AND source_buy_action_index >= 0
       AND source_buy_transaction_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_bundle_redistribution_members_causality_check CHECK (
       (connection_kind = 'redistribution_source'
         AND transfer_block IS NULL AND transfer_transaction_index IS NULL
         AND transfer_log_index IS NULL AND transfer_transaction_hash IS NULL
         AND transfer_amount_raw IS NULL
         AND sell_block IS NULL AND sell_transaction_index IS NULL
         AND sell_action_index IS NULL AND sell_transaction_hash IS NULL
         AND sell_delay_ms IS NULL)
       OR (connection_kind = 'rapid_sell_recipient'
         AND transfer_block > source_buy_block AND transfer_transaction_index >= 0
         AND transfer_log_index >= 0
         AND transfer_transaction_hash ~ '^0x[0-9a-f]{64}$'
         AND transfer_amount_raw > 0
         AND sell_block > transfer_block AND sell_transaction_index >= 0
         AND sell_action_index >= 0
         AND sell_transaction_hash ~ '^0x[0-9a-f]{64}$'
         AND sell_delay_ms BETWEEN 0 AND 300000)
     ),
     CONSTRAINT rh_bundle_redistribution_members_evidence_check CHECK (
       jsonb_typeof(evidence_json) = 'object' AND evidence_json <> '{}'::jsonb
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_redistribution_members_wallet
     ON robinhood_bundle_redistribution_members(
       chain, wallet_address, rule_version, token_address
     )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 187 Robinhood BUNDLED redistribution snapshots created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 187:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
