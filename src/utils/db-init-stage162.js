'use strict';

/** Stage 162 - permanent callout thesis archive and versioned summaries. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS callout_thesis_archive (
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
     thesis_sha256 VARCHAR(64),
     market_cap NUMERIC,
     source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     schema_version INTEGER NOT NULL DEFAULT 1,
     archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT callout_thesis_archive_profile_fkey
       FOREIGN KEY (platform, platform_user_id)
       REFERENCES callout_profiles(platform, platform_user_id) ON DELETE RESTRICT,
     CONSTRAINT callout_thesis_archive_platform_check CHECK (platform IN ('fomo', 'pump')),
     CONSTRAINT callout_thesis_archive_family_check CHECK (
       asset_chain_family IS NULL OR asset_chain_family IN ('evm', 'solana')
     ),
     CONSTRAINT callout_thesis_archive_metadata_check CHECK (
       jsonb_typeof(source_metadata) = 'object'
     ),
     CONSTRAINT callout_thesis_archive_hash_check CHECK (
       (thesis IS NULL AND thesis_sha256 IS NULL)
       OR (thesis IS NOT NULL AND thesis_sha256 ~ '^[0-9a-f]{64}$')
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_callout_thesis_archive_platform_event
     ON callout_thesis_archive(platform, platform_event_id)
     WHERE platform_event_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_callout_thesis_archive_asset_time
     ON callout_thesis_archive(
       asset_chain_key, asset_address_normalized, occurred_at DESC, dedupe_key
     )`,
  `CREATE INDEX IF NOT EXISTS idx_callout_thesis_archive_profile_time
     ON callout_thesis_archive(platform, platform_user_id, occurred_at DESC)`,
  `CREATE TABLE IF NOT EXISTS callout_summary_versions (
     summary_key TEXT PRIMARY KEY,
     cluster_key TEXT NOT NULL,
     version INTEGER NOT NULL,
     asset_chain_key TEXT NOT NULL,
     asset_address_normalized TEXT NOT NULL,
     window_started_at TIMESTAMPTZ NOT NULL,
     window_ended_at TIMESTAMPTZ NOT NULL,
     canonical_language VARCHAR(32) NOT NULL DEFAULT 'en',
     summary_text TEXT NOT NULL,
     source_count INTEGER NOT NULL,
     source_fingerprint VARCHAR(64) NOT NULL,
     source_snapshot JSONB NOT NULL,
     provider VARCHAR(32) NOT NULL,
     model TEXT NOT NULL,
     prompt_version TEXT NOT NULL,
     generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     supersedes_summary_key TEXT,
     generated_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT callout_summary_versions_cluster_version_key
       UNIQUE (cluster_key, version),
     CONSTRAINT callout_summary_versions_supersedes_fkey
       FOREIGN KEY (supersedes_summary_key)
       REFERENCES callout_summary_versions(summary_key) ON DELETE RESTRICT,
     CONSTRAINT callout_summary_versions_version_check CHECK (version >= 1),
     CONSTRAINT callout_summary_versions_window_check CHECK (
       window_ended_at >= window_started_at
     ),
     CONSTRAINT callout_summary_versions_text_check CHECK (BTRIM(summary_text) <> ''),
     CONSTRAINT callout_summary_versions_source_count_check CHECK (source_count >= 4),
     CONSTRAINT callout_summary_versions_source_fingerprint_check CHECK (
       source_fingerprint ~ '^[0-9a-f]{64}$'
     ),
     CONSTRAINT callout_summary_versions_sources_check CHECK (
       jsonb_typeof(source_snapshot) = 'array'
       AND jsonb_array_length(source_snapshot) = source_count
     ),
     CONSTRAINT callout_summary_versions_metadata_check CHECK (
       jsonb_typeof(generation_metadata) = 'object'
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_callout_summary_versions_successor
     ON callout_summary_versions(supersedes_summary_key)
     WHERE supersedes_summary_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_callout_summary_versions_generation
     ON callout_summary_versions(
       cluster_key, source_fingerprint, provider, model, prompt_version
     )`,
  `CREATE INDEX IF NOT EXISTS idx_callout_summary_versions_asset_time
     ON callout_summary_versions(
       asset_chain_key, asset_address_normalized, window_started_at DESC
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 162 callout archive and summary schema created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 162:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
