/** Stage 170 - resumable token-scoped Robinhood unified-position repair coverage. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_position_token_coverage (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     projection_version VARCHAR(64) NOT NULL DEFAULT 'unified_transfer_v1',
     shadow_projection_version VARCHAR(64) NOT NULL
       DEFAULT 'unified_transfer_token_repair_v1',
     source_transfer_version VARCHAR(64) NOT NULL DEFAULT 'rh_transfer_v1',
     token_address VARCHAR(42) NOT NULL,
     source_from_block BIGINT NOT NULL,
     next_block BIGINT NOT NULL,
     source_through_block BIGINT NOT NULL,
     source_through_hash VARCHAR(66) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'pending',
     lease_owner VARCHAR(128),
     lease_until TIMESTAMPTZ,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error_code VARCHAR(64),
     last_error_message VARCHAR(500),
     completed_at TIMESTAMPTZ,
     published_at TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_position_token_coverage_pkey PRIMARY KEY (
       chain, projection_version, token_address
     ),
     CONSTRAINT rh_wallet_position_token_coverage_identity_check CHECK (
       chain = 'robinhood'
       AND projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND shadow_projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND source_transfer_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND projection_version <> shadow_projection_version
       AND token_address ~ '^0x[0-9a-f]{40}$'
       AND token_address <> '0x0000000000000000000000000000000000000000'
     ),
     CONSTRAINT rh_wallet_position_token_coverage_bounds_check CHECK (
       source_from_block >= 0 AND source_through_block >= source_from_block
       AND next_block BETWEEN source_from_block AND source_through_block + 1
       AND source_through_hash ~ '^0x[0-9a-f]{64}$'
       AND attempt_count >= 0 AND version >= 0
     ),
     CONSTRAINT rh_wallet_position_token_coverage_status_check CHECK (
       status IN ('pending', 'leased', 'complete', 'failed')
     ),
     CONSTRAINT rh_wallet_position_token_coverage_lease_check CHECK (
       (status = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
     ),
     CONSTRAINT rh_wallet_position_token_coverage_completion_check CHECK (
       (status = 'complete' AND next_block = source_through_block + 1
         AND completed_at IS NOT NULL)
       OR (status <> 'complete' AND next_block <= source_through_block
         AND completed_at IS NULL)
     ),
     CONSTRAINT rh_wallet_position_token_coverage_publication_check CHECK (
       published_at IS NULL OR (status = 'complete'
         AND next_block = source_through_block + 1)
     ),
     CONSTRAINT rh_wallet_position_token_coverage_error_check CHECK (
       (last_error_code IS NULL) = (last_error_message IS NULL)
       AND (last_error_code IS NULL
         OR last_error_code ~ '^[a-z0-9][a-z0-9_:-]{0,63}$')
       AND (status <> 'failed' OR last_error_code IS NOT NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_position_token_coverage_claim
     ON robinhood_wallet_position_token_coverage(
       chain, projection_version, next_attempt_at, next_block, token_address
     ) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_position_token_coverage_lease
     ON robinhood_wallet_position_token_coverage(
       chain, projection_version, lease_until
     ) WHERE status = 'leased'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_position_token_coverage_publish
     ON robinhood_wallet_position_token_coverage(
       chain, projection_version, source_through_block, token_address
     ) WHERE status = 'complete' AND published_at IS NULL`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 170 Robinhood position token repair coverage created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 170:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
