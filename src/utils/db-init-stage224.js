'use strict';

/** Stage 224 - shadow lifecycle state for Robinhood head captures. */
const db = require('../models/db');

const TABLE_NAME = 'robinhood_head_capture_states';
const TRIGGER_NAME = 'rh_head_capture_state_sync';
const FUNCTION_NAME = 'sync_robinhood_head_capture_state';
const INDEX_NAMES = Object.freeze([
  'idx_rh_head_capture_states_claim',
  'idx_rh_head_capture_states_lease',
  'idx_rh_head_capture_states_retention',
]);

const TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
  transaction_hash VARCHAR(66) NOT NULL,
  log_index BIGINT NOT NULL,
  stream VARCHAR(16),
  protocol VARCHAR(16),
  market_key VARCHAR(160),
  block_number BIGINT,
  transaction_index BIGINT,
  processing_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  lease_owner VARCHAR(128),
  lease_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  terminal_at TIMESTAMPTZ,
  retention_eligible_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rh_head_capture_states_pkey PRIMARY KEY (
    chain, transaction_hash, log_index
  ),
  CONSTRAINT rh_head_capture_states_capture_fkey FOREIGN KEY (
    chain, transaction_hash, log_index
  ) REFERENCES robinhood_head_captures(
    chain, transaction_hash, log_index
  ) ON DELETE CASCADE,
  CONSTRAINT rh_head_capture_states_values_check CHECK (
    chain = 'robinhood' AND log_index >= 0 AND attempt_count >= 0
  ),
  CONSTRAINT rh_head_capture_states_status_check CHECK (
    processing_status IN ('pending', 'leased', 'processed', 'rejected', 'blocked')
  ),
  CONSTRAINT rh_head_capture_states_lease_check CHECK (
    (processing_status = 'leased')
    = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CONSTRAINT rh_head_capture_states_terminal_check CHECK (
    (processing_status IN ('processed', 'rejected'))
    = (terminal_at IS NOT NULL)
  ),
  CONSTRAINT rh_head_capture_states_retention_check CHECK (
    retention_eligible_at IS NULL OR (
      processing_status IN ('processed', 'rejected')
      AND terminal_at IS NOT NULL
      AND retention_eligible_at > terminal_at
    )
  )
)`;

const ROUTING_COLUMNS_STATEMENT = `ALTER TABLE ${TABLE_NAME}
  ADD COLUMN IF NOT EXISTS stream VARCHAR(16),
  ADD COLUMN IF NOT EXISTS protocol VARCHAR(16),
  ADD COLUMN IF NOT EXISTS market_key VARCHAR(160),
  ADD COLUMN IF NOT EXISTS block_number BIGINT,
  ADD COLUMN IF NOT EXISTS transaction_index BIGINT`;

const FUNCTION_STATEMENT = `CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO ${TABLE_NAME} (
    chain, transaction_hash, log_index, stream, protocol, market_key,
    block_number, transaction_index, processing_status,
    lease_owner, lease_until, attempt_count, next_attempt_at,
    last_error, terminal_at, retention_eligible_at, created_at, updated_at
  ) VALUES (
    NEW.chain, NEW.transaction_hash, NEW.log_index, NEW.stream, NEW.protocol,
    NEW.market_key, NEW.block_number, NEW.transaction_index, NEW.processing_status,
    NEW.lease_owner, NEW.lease_until, NEW.attempt_count, NEW.next_attempt_at,
    NEW.last_error, NEW.terminal_at, NEW.retention_eligible_at,
    NEW.created_at, NEW.updated_at
  )
  ON CONFLICT (chain, transaction_hash, log_index) DO UPDATE SET
    stream = EXCLUDED.stream,
    protocol = EXCLUDED.protocol,
    market_key = EXCLUDED.market_key,
    block_number = EXCLUDED.block_number,
    transaction_index = EXCLUDED.transaction_index,
    processing_status = EXCLUDED.processing_status,
    lease_owner = EXCLUDED.lease_owner,
    lease_until = EXCLUDED.lease_until,
    attempt_count = EXCLUDED.attempt_count,
    next_attempt_at = EXCLUDED.next_attempt_at,
    last_error = EXCLUDED.last_error,
    terminal_at = EXCLUDED.terminal_at,
    retention_eligible_at = EXCLUDED.retention_eligible_at,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END
$function$`;

const TRIGGER_STATEMENT = `DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = '${TRIGGER_NAME}'
       AND tgrelid = 'robinhood_head_captures'::regclass
       AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER ${TRIGGER_NAME}
      AFTER INSERT OR UPDATE OF processing_status, lease_owner, lease_until,
        attempt_count, next_attempt_at, last_error, terminal_at,
        retention_eligible_at, updated_at
      ON robinhood_head_captures
      FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}()';
  END IF;
END
$block$`;

const STATEMENTS = Object.freeze([
  TABLE_STATEMENT,
  ROUTING_COLUMNS_STATEMENT,
  `ALTER TABLE ${TABLE_NAME} SET (
    autovacuum_vacuum_scale_factor = 0.001,
    autovacuum_vacuum_threshold = 100000,
    autovacuum_analyze_scale_factor = 0.005,
    autovacuum_analyze_threshold = 100000,
    autovacuum_vacuum_cost_delay = 10,
    autovacuum_vacuum_cost_limit = 300
  )`,
  FUNCTION_STATEMENT,
  TRIGGER_STATEMENT,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[0]}
     ON ${TABLE_NAME}(next_attempt_at, transaction_hash, log_index)
     WHERE processing_status = 'pending'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[1]}
     ON ${TABLE_NAME}(lease_until)
     WHERE processing_status = 'leased'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[2]}
     ON ${TABLE_NAME}(retention_eligible_at)
     WHERE retention_eligible_at IS NOT NULL`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      for (const statement of STATEMENTS.slice(0, -INDEX_NAMES.length)) {
        await client.query(statement);
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
    for (const statement of STATEMENTS.slice(-INDEX_NAMES.length)) {
      await database.query(statement);
    }
    console.log('Stage 224 Robinhood head capture shadow state created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 224:', error.message);
  process.exitCode = 1;
});

module.exports = {
  FUNCTION_NAME, FUNCTION_STATEMENT, INDEX_NAMES, STATEMENTS,
  ROUTING_COLUMNS_STATEMENT, TABLE_NAME, TABLE_STATEMENT, TRIGGER_NAME,
  TRIGGER_STATEMENT, init,
};
