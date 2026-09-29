'use strict';

/** Stage 256 - durable token scope for committed wallet-transfer scans. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_scan_scopes (
     scan_scope_id BIGINT GENERATED ALWAYS AS IDENTITY,
     chain VARCHAR(32) NOT NULL,
     projection_version VARCHAR(64) NOT NULL,
     stream VARCHAR(8) NOT NULL,
     from_block BIGINT NOT NULL,
     through_block BIGINT NOT NULL,
     checkpoint_hash VARCHAR(66) NOT NULL,
     token_addresses TEXT[] NOT NULL,
     filter_mode VARCHAR(32) NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_transfer_scan_scopes_pkey PRIMARY KEY (scan_scope_id),
     CONSTRAINT rh_wallet_transfer_scan_scopes_bounds_check CHECK (
       from_block >= 0 AND through_block >= from_block
     ),
     CONSTRAINT rh_wallet_transfer_scan_scopes_stream_check CHECK (stream IN ('seed', 'live')),
     CONSTRAINT rh_wallet_transfer_scan_scopes_scope_check CHECK (
       cardinality(token_addresses) > 0
         AND filter_mode IN ('address-filtered', 'topics-only')
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_scan_scopes_range
     ON robinhood_wallet_transfer_scan_scopes (
       chain, projection_version, stream, through_block, from_block, checkpoint_hash
     )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_wallet_transfer_scan_scopes_tokens
     ON robinhood_wallet_transfer_scan_scopes USING GIN (token_addresses)`,
]);

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query('COMMIT');
    console.log('Stage 256 Robinhood transfer scan scopes created successfully');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 256:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
