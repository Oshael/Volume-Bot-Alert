/** Stage 181 - canonical first signed activity and scan cursor for FRESH LIVE. */
const db = require('../models/db');

const EVIDENCE_VERSION = 'rh_signed_origin_v1';

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_signed_origins (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     wallet_address VARCHAR(42) NOT NULL,
     first_block_number BIGINT NOT NULL,
     first_block_hash VARCHAR(66) NOT NULL,
     first_block_time TIMESTAMPTZ NOT NULL,
     first_transaction_hash VARCHAR(66) NOT NULL,
     first_transaction_index INTEGER NOT NULL,
     first_nonce NUMERIC(78,0) NOT NULL,
     coverage_origin_block BIGINT NOT NULL,
     source_stream VARCHAR(8) NOT NULL,
     evidence_version VARCHAR(64) NOT NULL DEFAULT '${EVIDENCE_VERSION}',
     observed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_signed_origins_pkey PRIMARY KEY (chain, wallet_address),
     CONSTRAINT rh_wallet_signed_origins_tx_unique UNIQUE (
       chain, first_transaction_hash
     ),
     CONSTRAINT rh_wallet_signed_origins_contract_check CHECK (
       chain = 'robinhood'
       AND wallet_address ~ '^0x[0-9a-f]{40}$'
       AND first_block_hash ~ '^0x[0-9a-f]{64}$'
       AND first_transaction_hash ~ '^0x[0-9a-f]{64}$'
       AND first_block_number >= 0
       AND coverage_origin_block >= 0
       AND first_block_number >= coverage_origin_block
       AND first_transaction_index >= 0
       AND first_nonce >= 0
       AND source_stream IN ('seed', 'live')
       AND evidence_version = '${EVIDENCE_VERSION}'
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_signed_origins_position
     ON robinhood_wallet_signed_origins(
       chain, first_block_number, first_transaction_index, wallet_address
     )`,
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_signed_origin_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     stream VARCHAR(8) NOT NULL,
     origin_block BIGINT NOT NULL,
     next_block BIGINT NOT NULL,
     safe_head BIGINT,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     checkpoint_timestamp TIMESTAMPTZ,
     lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'planned',
     last_error_code VARCHAR(64),
     last_error_message TEXT,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_signed_origin_cursors_pkey PRIMARY KEY (chain, stream),
     CONSTRAINT rh_wallet_signed_origin_cursors_contract_check CHECK (
       chain = 'robinhood'
       AND stream IN ('seed', 'live')
       AND lifecycle_state IN ('planned', 'running', 'caught_up', 'completed', 'halted')
       AND origin_block >= 0 AND next_block >= origin_block
       AND (safe_head IS NULL OR safe_head >= 0)
       AND version >= 0
       AND (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
     ),
     CONSTRAINT rh_wallet_signed_origin_cursors_checkpoint_check CHECK (
       (checkpoint_block IS NULL AND checkpoint_hash IS NULL
         AND checkpoint_timestamp IS NULL AND next_block = origin_block)
       OR (checkpoint_block IS NOT NULL AND checkpoint_hash IS NOT NULL
         AND checkpoint_block = next_block - 1
         AND checkpoint_block >= origin_block
         AND checkpoint_hash ~ '^0x[0-9a-f]{64}$'
         AND checkpoint_timestamp IS NOT NULL)
     ),
     CONSTRAINT rh_wallet_signed_origin_cursors_frontier_check CHECK (
       (safe_head IS NULL OR checkpoint_block IS NULL OR checkpoint_block <= safe_head)
       AND (lifecycle_state NOT IN ('caught_up', 'completed')
         OR (safe_head IS NOT NULL AND next_block = safe_head + 1))
       AND (lifecycle_state <> 'completed' OR stream = 'seed')
     )
   )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 181 Robinhood wallet signed origins created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 181:', error.message);
  process.exitCode = 1;
});

module.exports = { EVIDENCE_VERSION, STATEMENTS, init };
