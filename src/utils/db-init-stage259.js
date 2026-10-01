'use strict';

const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_scope_heads (
     scope_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     chain VARCHAR(32) NOT NULL CHECK (chain='robinhood'),
     projection_version VARCHAR(64) NOT NULL CHECK (projection_version ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
     stream VARCHAR(8) NOT NULL CHECK (stream IN ('seed','live')),
     baseline_scan_scope_id BIGINT NOT NULL CONSTRAINT rh_transfer_scope_baseline_fkey
       REFERENCES robinhood_wallet_transfer_scan_scopes(scan_scope_id),
     baseline_cursor_version BIGINT NOT NULL CHECK (baseline_cursor_version>=0),
     baseline_next_block BIGINT NOT NULL CHECK (baseline_next_block>0),
     baseline_checkpoint_hash VARCHAR(66) NOT NULL CHECK (baseline_checkpoint_hash ~ '^0x[0-9a-f]{64}$'),
     scope_hash VARCHAR(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
     current_version BIGINT NOT NULL DEFAULT 0 CHECK (current_version>=0),
     token_count INTEGER NOT NULL CHECK (token_count>0),
     loaded_tokens INTEGER NOT NULL DEFAULT 0,
     state VARCHAR(16) NOT NULL DEFAULT 'preparing',
     CONSTRAINT rh_transfer_scope_head_identity UNIQUE (chain,projection_version,stream),
     CONSTRAINT rh_transfer_scope_head_reference UNIQUE (chain,projection_version,stream,scope_id),
     CONSTRAINT rh_transfer_scope_head_progress CHECK (
       loaded_tokens BETWEEN 0 AND token_count AND state IN ('preparing','ready')
       AND (state='ready')=(loaded_tokens=token_count))
   )`,
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_scope_versions (
     scope_id BIGINT NOT NULL CONSTRAINT rh_transfer_scope_version_head_fkey
       REFERENCES robinhood_wallet_transfer_scope_heads(scope_id),
     scope_version BIGINT NOT NULL CHECK (scope_version>=0),
     scope_hash VARCHAR(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
     PRIMARY KEY (scope_id,scope_version)
   )`,
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_scope_members (
     scope_id BIGINT NOT NULL,
     token_address VARCHAR(42) NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     valid_from_version BIGINT NOT NULL,
     valid_to_version BIGINT,
     PRIMARY KEY (scope_id,token_address,valid_from_version),
     CONSTRAINT rh_transfer_scope_member_bounds CHECK (
       valid_from_version>=0 AND (valid_to_version IS NULL OR valid_to_version>valid_from_version)),
     CONSTRAINT rh_transfer_scope_member_from_fkey FOREIGN KEY (scope_id,valid_from_version)
       REFERENCES robinhood_wallet_transfer_scope_versions(scope_id,scope_version),
     CONSTRAINT rh_transfer_scope_member_to_fkey FOREIGN KEY (scope_id,valid_to_version)
       REFERENCES robinhood_wallet_transfer_scope_versions(scope_id,scope_version)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_transfer_scope_member_open
     ON robinhood_wallet_transfer_scope_members(scope_id,token_address) WHERE valid_to_version IS NULL`,
  `ALTER TABLE robinhood_wallet_transfer_scan_scopes ADD COLUMN IF NOT EXISTS scope_id BIGINT,
     ADD COLUMN IF NOT EXISTS scope_version BIGINT`,
  `ALTER TABLE robinhood_wallet_transfer_scan_scopes DROP CONSTRAINT IF EXISTS rh_transfer_scan_token_scope_check`,
  `ALTER TABLE robinhood_wallet_transfer_scan_scopes ADD CONSTRAINT rh_transfer_scan_token_scope_check CHECK (
     (scope_id IS NULL AND scope_version IS NULL AND (
       (token_scope_hash IS NULL AND token_addresses IS NOT NULL AND cardinality(token_addresses)>0)
       OR (token_scope_hash IS NOT NULL AND token_addresses IS NULL)))
     OR (scope_id IS NOT NULL AND scope_version IS NOT NULL AND scope_version>=0
       AND token_scope_hash IS NULL AND token_addresses IS NULL)) NOT VALID`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='robinhood_wallet_transfer_scope_heads'::regclass
       AND conname='rh_transfer_scope_current_version_fkey') THEN
       ALTER TABLE robinhood_wallet_transfer_scope_heads ADD CONSTRAINT rh_transfer_scope_current_version_fkey
         FOREIGN KEY (scope_id,current_version) REFERENCES robinhood_wallet_transfer_scope_versions(scope_id,scope_version)
         DEFERRABLE INITIALLY DEFERRED;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='robinhood_wallet_transfer_scan_scopes'::regclass
       AND conname='rh_transfer_scan_scope_version_fkey') THEN
       ALTER TABLE robinhood_wallet_transfer_scan_scopes ADD CONSTRAINT rh_transfer_scan_scope_version_fkey
         FOREIGN KEY (scope_id,scope_version)
         REFERENCES robinhood_wallet_transfer_scope_versions(scope_id,scope_version) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='robinhood_wallet_transfer_scan_scopes'::regclass
       AND conname='rh_transfer_scan_scope_identity_fkey') THEN
       ALTER TABLE robinhood_wallet_transfer_scan_scopes ADD CONSTRAINT rh_transfer_scan_scope_identity_fkey
         FOREIGN KEY (chain,projection_version,stream,scope_id)
         REFERENCES robinhood_wallet_transfer_scope_heads(chain,projection_version,stream,scope_id) NOT VALID;
     END IF;
   END $$`,
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
  console.error('Stage 259 transfer scope membership failed:', error.message);
  process.exitCode = 1;
});
module.exports = { STATEMENTS, init };
