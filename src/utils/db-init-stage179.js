/** Stage 179 - durable per-wallet FRESH shadow evaluations. */
const db = require('../models/db');

const RULE_VERSION = 'rh_fresh_signed_v1';
const CLASSIFICATION_VERSION = 'rh_holder_v1';

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_fresh_wallet_evaluations (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     wallet_address VARCHAR(42) NOT NULL,
     rule_version VARCHAR(64) NOT NULL DEFAULT '${RULE_VERSION}',
     classification_version VARCHAR(32) NOT NULL DEFAULT '${CLASSIFICATION_VERSION}',
     queue_version BIGINT NOT NULL,
     status VARCHAR(16) NOT NULL,
     outcome VARCHAR(16),
     status_reason VARCHAR(64) NOT NULL,
     evidence_json JSONB NOT NULL,
     through_block_number BIGINT,
     through_block_hash VARCHAR(66),
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_fresh_wallet_evaluations_pkey PRIMARY KEY (
       chain, token_address, wallet_address, rule_version
     ),
     CONSTRAINT rh_fresh_wallet_evaluations_queue_fkey
       FOREIGN KEY (chain, token_address, wallet_address, rule_version)
       REFERENCES robinhood_fresh_wallet_queue(
         chain, token_address, wallet_address, rule_version
       ) ON DELETE CASCADE,
     CONSTRAINT rh_fresh_wallet_evaluations_contract_check CHECK (
       chain = 'robinhood' AND rule_version = '${RULE_VERSION}'
       AND classification_version = '${CLASSIFICATION_VERSION}'
       AND token_address ~ '^0x[0-9a-f]{40}$'
       AND wallet_address ~ '^0x[0-9a-f]{40}$'
       AND queue_version >= 1
       AND status IN ('pending', 'ready', 'unavailable', 'stale', 'reorged')
       AND status_reason ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
       AND jsonb_typeof(evidence_json) = 'object'
       AND evidence_json <> '{}'::jsonb
       AND ((status = 'ready') = (outcome IS NOT NULL))
       AND (outcome IS NULL OR outcome IN ('fresh', 'not_fresh'))
     ),
     CONSTRAINT rh_fresh_wallet_evaluations_frontier_check CHECK (
       (through_block_number IS NULL) = (through_block_hash IS NULL)
       AND (through_block_number IS NULL OR through_block_number >= 0)
       AND (through_block_hash IS NULL OR through_block_hash ~ '^0x[0-9a-f]{64}$')
       AND ((status IN ('ready', 'stale', 'reorged')) =
         (through_block_number IS NOT NULL))
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_fresh_wallet_evaluations_status
     ON robinhood_fresh_wallet_evaluations(
       chain, rule_version, status, token_address, wallet_address
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 179 Robinhood FRESH shadow evaluations created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 179:', error.message);
  process.exitCode = 1;
});

module.exports = { CLASSIFICATION_VERSION, RULE_VERSION, STATEMENTS, init };
