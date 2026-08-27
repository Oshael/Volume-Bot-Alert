/** Stage 169 - token-scoped causal native-funding evidence. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_funding_evidence (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     run_id BIGINT NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     candidate_wallet VARCHAR(42) NOT NULL,
     hop SMALLINT NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_time TIMESTAMPTZ NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     from_wallet VARCHAR(42) NOT NULL,
     to_wallet VARCHAR(42) NOT NULL,
     value_wei NUMERIC(78,0) NOT NULL,
     evidence_version VARCHAR(64) NOT NULL DEFAULT 'rh_native_funding_v2',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_bundle_funding_evidence_pkey PRIMARY KEY (
       chain, run_id, token_address, candidate_wallet, transaction_hash, hop
     ),
     CONSTRAINT rh_bundle_funding_evidence_candidate_fkey FOREIGN KEY (
       run_id, token_address, candidate_wallet
     ) REFERENCES robinhood_bundle_funding_backfill_candidates(
       run_id, token_address, wallet_address
     ) ON DELETE CASCADE,
     CONSTRAINT rh_bundle_funding_evidence_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_bundle_funding_evidence_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$'
       AND candidate_wallet ~ '^0x[0-9a-f]{40}$'
       AND from_wallet ~ '^0x[0-9a-f]{40}$'
       AND to_wallet ~ '^0x[0-9a-f]{40}$'
       AND from_wallet <> to_wallet
     ),
     CONSTRAINT rh_bundle_funding_evidence_hash_check CHECK (
       block_hash ~ '^0x[0-9a-f]{64}$'
       AND transaction_hash ~ '^0x[0-9a-f]{64}$'
     ),
     CONSTRAINT rh_bundle_funding_evidence_position_check CHECK (
       block_number >= 0 AND transaction_index >= 0
     ),
     CONSTRAINT rh_bundle_funding_evidence_hop_check CHECK (
       (hop = 1 AND to_wallet = candidate_wallet)
       OR (hop = 2 AND to_wallet <> candidate_wallet
         AND from_wallet <> candidate_wallet)
     ),
     CONSTRAINT rh_bundle_funding_evidence_value_check CHECK (value_wei > 0),
     CONSTRAINT rh_bundle_funding_evidence_version_check CHECK (
       evidence_version ~ '^rh_native_funding_v[1-9][0-9]*$'
     )
   )`,
  `ALTER TABLE robinhood_bundle_funding_evidence
     ALTER COLUMN evidence_version SET DEFAULT 'rh_native_funding_v2'`,
  `ALTER TABLE robinhood_bundle_funding_backfill_runs
     ALTER COLUMN evidence_version SET DEFAULT 'rh_native_funding_v2'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_evidence_token
     ON robinhood_bundle_funding_evidence(
       token_address, run_id, candidate_wallet, hop, block_number, transaction_index
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_evidence_path
     ON robinhood_bundle_funding_evidence(
       run_id, token_address, to_wallet, from_wallet, block_number
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 169 Robinhood token-scoped funding evidence created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 169:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
