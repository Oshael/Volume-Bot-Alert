/** Stage 173 - current token-scoped evidence produced by the VPS Archive worker. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_bundle_funding_live_evidence (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     queue_version BIGINT NOT NULL,
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
     CONSTRAINT rh_bundle_funding_live_evidence_pkey PRIMARY KEY (
       chain, token_address, queue_version, candidate_wallet, transaction_hash, hop
     ),
     CONSTRAINT rh_bundle_funding_live_evidence_queue_fkey FOREIGN KEY (
       chain, token_address
     ) REFERENCES robinhood_bundle_funding_live_queue(chain, token_address)
       ON DELETE CASCADE,
     CONSTRAINT rh_bundle_funding_live_evidence_address_check CHECK (
       token_address ~ '^0x[0-9a-f]{40}$' AND candidate_wallet ~ '^0x[0-9a-f]{40}$'
       AND from_wallet ~ '^0x[0-9a-f]{40}$' AND to_wallet ~ '^0x[0-9a-f]{40}$'
       AND from_wallet <> to_wallet
     ),
     CONSTRAINT rh_bundle_funding_live_evidence_position_check CHECK (
       queue_version >= 1 AND block_number >= 0 AND transaction_index >= 0
       AND hop IN (1, 2) AND value_wei > 0
     ),
     CONSTRAINT rh_bundle_funding_live_evidence_hop_check CHECK (
       (hop = 1 AND to_wallet = candidate_wallet)
       OR (hop = 2 AND to_wallet <> candidate_wallet AND from_wallet <> candidate_wallet)
     ),
     CONSTRAINT rh_bundle_funding_live_evidence_hash_check CHECK (
       block_hash ~ '^0x[0-9a-f]{64}$' AND transaction_hash ~ '^0x[0-9a-f]{64}$'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_bundle_funding_live_evidence_token
     ON robinhood_bundle_funding_live_evidence(
       token_address, queue_version, candidate_wallet, hop, block_number
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 173 Robinhood BUNDLED live evidence created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 173:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
