/**
 * Stage 63 - Robinhood persistence control plane.
 * Creates the permanent pool registry/cursors and a compact three-day log
 * identity ledger. It does not enable the runtime writer.
 * Run with: node src/utils/db-init-stage63.js
 */
const db = require('../models/db');

const PROCESSED_LOG_RETENTION_DAYS = 3;
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS robinhood_pool_registry (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     protocol VARCHAR(16) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     pool_address VARCHAR(42),
     pool_id VARCHAR(66),
     origin_address VARCHAR(42),
     token_address VARCHAR(42) NOT NULL,
     quote_address VARCHAR(42) NOT NULL,
     currency0 VARCHAR(42) NOT NULL,
     currency1 VARCHAR(42) NOT NULL,
     fee INTEGER,
     tick_spacing INTEGER,
     hooks_address VARCHAR(42),
     discovery_block BIGINT NOT NULL,
     discovery_block_hash VARCHAR(66) NOT NULL,
     discovery_tx_hash VARCHAR(66) NOT NULL,
     discovery_log_index BIGINT NOT NULL,
     discovered_at TIMESTAMPTZ NOT NULL,
     active BOOLEAN NOT NULL DEFAULT true,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_pool_registry_pkey PRIMARY KEY (chain, protocol, market_key),
     CONSTRAINT robinhood_pool_registry_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_pool_registry_protocol_check
       CHECK (protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')),
     CONSTRAINT robinhood_pool_registry_identity_check CHECK (
       (protocol = 'uniswap-v4' AND pool_id IS NOT NULL AND pool_address IS NULL)
       OR (protocol <> 'uniswap-v4' AND pool_address IS NOT NULL AND pool_id IS NULL)
     ),
     CONSTRAINT robinhood_pool_registry_discovery_block_check CHECK (discovery_block >= 0),
     CONSTRAINT robinhood_pool_registry_discovery_log_index_check CHECK (discovery_log_index >= 0)
   )`,
  `ALTER TABLE robinhood_pool_registry
     ADD COLUMN IF NOT EXISTS origin_address VARCHAR(42)`,
  `DO $migration$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'robinhood_pool_registry'
         AND column_name = 'manager_address'
     ) THEN
       UPDATE robinhood_pool_registry
       SET origin_address = manager_address
       WHERE origin_address IS NULL AND manager_address IS NOT NULL;
     END IF;
   END
   $migration$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_robinhood_pool_registry_address
     ON robinhood_pool_registry(chain, protocol, pool_address)
     WHERE pool_address IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_robinhood_pool_registry_pool_id
     ON robinhood_pool_registry(chain, protocol, pool_id)
     WHERE pool_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_pool_registry_active_token
     ON robinhood_pool_registry(chain, token_address, protocol, updated_at DESC)
     WHERE active = true`,

  `CREATE TABLE IF NOT EXISTS robinhood_ingestion_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     stream VARCHAR(16) NOT NULL,
     next_block BIGINT NOT NULL,
     safe_head BIGINT,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     checkpoint_timestamp TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_ingestion_cursors_pkey PRIMARY KEY (chain, stream),
     CONSTRAINT robinhood_ingestion_cursors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_ingestion_cursors_stream_check CHECK (stream IN ('discovery', 'market')),
     CONSTRAINT robinhood_ingestion_cursors_next_block_check CHECK (next_block >= 0),
     CONSTRAINT robinhood_ingestion_cursors_safe_head_check CHECK (safe_head IS NULL OR safe_head >= 0),
     CONSTRAINT robinhood_ingestion_cursors_checkpoint_block_check
       CHECK (checkpoint_block IS NULL OR checkpoint_block >= 0),
     CONSTRAINT robinhood_ingestion_cursors_checkpoint_pair_check
       CHECK ((checkpoint_block IS NULL) = (checkpoint_hash IS NULL))
   )`,

  `CREATE TABLE IF NOT EXISTS robinhood_processed_logs (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     transaction_hash VARCHAR(66) NOT NULL,
     log_index BIGINT NOT NULL,
     stream VARCHAR(16) NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     topic0 VARCHAR(66) NOT NULL,
     event_kind VARCHAR(32),
     protocol VARCHAR(16),
     market_key VARCHAR(160),
     processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '${PROCESSED_LOG_RETENTION_DAYS} days',
     CONSTRAINT robinhood_processed_logs_pkey PRIMARY KEY (chain, transaction_hash, log_index),
     CONSTRAINT robinhood_processed_logs_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_processed_logs_stream_check CHECK (stream IN ('discovery', 'market')),
     CONSTRAINT robinhood_processed_logs_protocol_check CHECK (
       protocol IS NULL OR protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
     ),
     CONSTRAINT robinhood_processed_logs_block_check CHECK (block_number >= 0),
     CONSTRAINT robinhood_processed_logs_log_index_check CHECK (log_index >= 0),
     CONSTRAINT robinhood_processed_logs_expiry_check CHECK (expires_at > processed_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_processed_logs_expiry
     ON robinhood_processed_logs(expires_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_processed_logs_block
     ON robinhood_processed_logs(chain, stream, block_number DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_robinhood_processed_logs_market
     ON robinhood_processed_logs(chain, market_key, block_number DESC)
     WHERE market_key IS NOT NULL`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 63 Robinhood persistence control plane created successfully');
  } catch (error) {
    console.error('Failed to create stage 63 Robinhood persistence control plane:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { PROCESSED_LOG_RETENTION_DAYS, STATEMENTS, init };
