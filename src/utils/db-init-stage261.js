'use strict';
const db = require('../models/db');
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_global_scans (
    global_scan_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain VARCHAR(32) NOT NULL CHECK (chain='robinhood'),
    projection_version VARCHAR(64) NOT NULL,
    stream VARCHAR(8) NOT NULL CHECK (stream IN ('seed','live')),
    from_block BIGINT NOT NULL,
    through_block BIGINT NOT NULL,
    checkpoint_hash VARCHAR(66) NOT NULL CHECK (checkpoint_hash ~ '^0x[0-9a-f]{64}$'),
    cursor_version BIGINT NOT NULL CHECK (cursor_version>0),
    reader_version VARCHAR(32) NOT NULL CHECK (reader_version='canonical-global-v1'),
    observed_logs INTEGER NOT NULL CHECK (observed_logs BETWEEN 0 AND 100000),
    observed_contracts INTEGER NOT NULL CHECK (observed_contracts BETWEEN 0 AND 10000),
    selected_contracts INTEGER NOT NULL,
    excluded_token_addresses TEXT[] NOT NULL,
    proof_hash VARCHAR(64) NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT rh_transfer_global_scan_bounds CHECK (
      from_block>=0 AND through_block>=from_block AND through_block-from_block<5000
      AND through_block<9223372036854775807),
    CONSTRAINT rh_transfer_global_scan_payload CHECK (
      selected_contracts BETWEEN 0 AND observed_contracts AND observed_logs>=observed_contracts
      AND (observed_logs=0)=(observed_contracts=0)
      AND cardinality(excluded_token_addresses)=observed_contracts-selected_contracts
      AND array_position(excluded_token_addresses,NULL) IS NULL
      AND octet_length(excluded_token_addresses::text)<=450002
      AND (cardinality(excluded_token_addresses)=0 OR array_to_string(excluded_token_addresses,',')
        ~ '^0x[0-9a-f]{40}(,0x[0-9a-f]{40})*$')),
    CONSTRAINT rh_transfer_global_scan_cursor FOREIGN KEY (chain,projection_version,stream)
      REFERENCES robinhood_wallet_transfer_cursors(chain,projection_version,stream),
    CONSTRAINT rh_transfer_global_scan_identity UNIQUE
      (chain,projection_version,stream,from_block,through_block,checkpoint_hash,reader_version,cursor_version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_transfer_global_scan_range ON robinhood_wallet_transfer_global_scans
    (chain,projection_version,stream,through_block,from_block,checkpoint_hash)`,
]);
async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end();
  }
}
if (require.main === module) init().catch((error) => {
  console.error('Stage 261 global transfer scan proof failed:', error.message);
  process.exitCode = 1;
});
module.exports = { STATEMENTS, init };
