'use strict';

const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_token_scopes (
     chain VARCHAR(32) NOT NULL,
     scope_hash VARCHAR(64) NOT NULL,
     token_addresses TEXT[] NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_transfer_token_scopes_pkey PRIMARY KEY (chain, scope_hash),
     CONSTRAINT rh_transfer_token_scopes_hash_check CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT rh_transfer_token_scopes_tokens_check CHECK (cardinality(token_addresses) > 0)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_transfer_token_scopes_tokens
     ON robinhood_wallet_transfer_token_scopes USING GIN (token_addresses)`,
  `ALTER TABLE robinhood_wallet_transfer_scan_scopes
     ADD COLUMN IF NOT EXISTS token_scope_hash VARCHAR(64)`,
  `ALTER TABLE robinhood_wallet_transfer_scan_scopes
     ALTER COLUMN token_addresses DROP NOT NULL`,
  // Existing rows have non-null arrays and a null reference. Avoid detoasting history.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid='robinhood_wallet_transfer_scan_scopes'::regclass
         AND conname='rh_transfer_scan_token_scope_check') THEN
       ALTER TABLE robinhood_wallet_transfer_scan_scopes
         ADD CONSTRAINT rh_transfer_scan_token_scope_check CHECK (
           (token_scope_hash IS NULL AND token_addresses IS NOT NULL
             AND cardinality(token_addresses) > 0)
           OR (token_scope_hash IS NOT NULL AND token_addresses IS NULL)
         ) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conrelid='robinhood_wallet_transfer_scan_scopes'::regclass
         AND conname='rh_transfer_scan_token_scope_fkey') THEN
       ALTER TABLE robinhood_wallet_transfer_scan_scopes
         ADD CONSTRAINT rh_transfer_scan_token_scope_fkey
         FOREIGN KEY (chain, token_scope_hash)
         REFERENCES robinhood_wallet_transfer_token_scopes(chain, scope_hash) NOT VALID;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS idx_rh_transfer_scan_token_scope_range
     ON robinhood_wallet_transfer_scan_scopes (
       chain, token_scope_hash, through_block, from_block
     ) WHERE token_scope_hash IS NOT NULL`,
]);

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 258:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
