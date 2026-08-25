'use strict';

/** Stage 161 - durable Pump/Fomo callout capture foundation. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS callout_profiles (
     platform VARCHAR(16) NOT NULL,
     platform_user_id TEXT NOT NULL,
     username TEXT,
     x_username TEXT,
     display_name TEXT,
     profile_picture_url TEXT,
     latest_source TEXT,
     first_observed_at TIMESTAMPTZ NOT NULL,
     last_observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT callout_profiles_pkey PRIMARY KEY (platform, platform_user_id),
     CONSTRAINT callout_profiles_platform_check CHECK (platform IN ('fomo', 'pump')),
     CONSTRAINT callout_profiles_observed_check CHECK (last_observed_at >= first_observed_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_callout_profiles_last_observed
     ON callout_profiles(last_observed_at DESC)`,
  `CREATE TABLE IF NOT EXISTS callout_wallet_observations (
     observation_key TEXT PRIMARY KEY,
     platform VARCHAR(16) NOT NULL,
     platform_user_id TEXT NOT NULL,
     address_original TEXT NOT NULL,
     address_normalized TEXT,
     raw_chain_id TEXT,
     chain_key TEXT,
     chain_family VARCHAR(16),
     resolution_status VARCHAR(32) NOT NULL,
     relation_type VARCHAR(32) NOT NULL,
     source_type VARCHAR(32) NOT NULL,
     source_field TEXT,
     source_record_id TEXT,
     confidence VARCHAR(16),
     evidence_at TIMESTAMPTZ,
     first_observed_at TIMESTAMPTZ NOT NULL,
     last_observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT callout_wallet_observations_profile_fkey
       FOREIGN KEY (platform, platform_user_id)
       REFERENCES callout_profiles(platform, platform_user_id) ON DELETE RESTRICT,
     CONSTRAINT callout_wallet_observations_platform_check CHECK (platform IN ('fomo', 'pump')),
     CONSTRAINT callout_wallet_observations_family_check CHECK (
       chain_family IS NULL OR chain_family IN ('evm', 'solana')
     ),
     CONSTRAINT callout_wallet_observations_observed_check CHECK (
       last_observed_at >= first_observed_at
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_callout_wallet_observations_profile
     ON callout_wallet_observations(platform, platform_user_id, last_observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_callout_wallet_observations_address
     ON callout_wallet_observations(chain_key, address_normalized)
     WHERE address_normalized IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS callout_events (
     dedupe_key TEXT PRIMARY KEY,
     platform VARCHAR(16) NOT NULL,
     platform_event_id TEXT,
     platform_user_id TEXT,
     occurred_at TIMESTAMPTZ,
     captured_at TIMESTAMPTZ NOT NULL,
     asset_address_original TEXT,
     asset_address_normalized TEXT,
     asset_raw_chain_id TEXT,
     asset_chain_key TEXT,
     asset_chain_family VARCHAR(16),
     asset_resolution_status VARCHAR(32) NOT NULL,
     thesis TEXT,
     market_cap NUMERIC,
     source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT callout_events_profile_fkey
       FOREIGN KEY (platform, platform_user_id)
       REFERENCES callout_profiles(platform, platform_user_id) ON DELETE RESTRICT,
     CONSTRAINT callout_events_platform_check CHECK (platform IN ('fomo', 'pump')),
     CONSTRAINT callout_events_family_check CHECK (
       asset_chain_family IS NULL OR asset_chain_family IN ('evm', 'solana')
     ),
     CONSTRAINT callout_events_metadata_check CHECK (jsonb_typeof(source_metadata) = 'object'),
     CONSTRAINT callout_events_retention_check CHECK (expires_at = captured_at + INTERVAL '72 hours')
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_callout_events_platform_event
     ON callout_events(platform, platform_event_id)
     WHERE platform_event_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_callout_events_asset_time
     ON callout_events(asset_chain_key, asset_address_normalized, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_callout_events_expiry
     ON callout_events(expires_at)`,
  `CREATE TABLE IF NOT EXISTS callout_collector_checkpoints (
     collector_key TEXT PRIMARY KEY,
     state JSONB NOT NULL DEFAULT '{}'::jsonb,
     last_committed_at TIMESTAMPTZ,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT callout_collector_checkpoints_state_check CHECK (jsonb_typeof(state) = 'object')
   )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 161 callout capture foundation created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 161:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
