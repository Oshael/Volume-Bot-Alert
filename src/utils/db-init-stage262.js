'use strict';
const db = require('../models/db');
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_scope_dictionary (
    chain VARCHAR(32) NOT NULL CHECK (chain='robinhood'),
    ordinal INTEGER GENERATED ALWAYS AS IDENTITY (MINVALUE 0 MAXVALUE 999999 START WITH 0),
    token_address VARCHAR(42) NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT rh_transfer_dictionary_pkey PRIMARY KEY(chain,ordinal),
    CONSTRAINT rh_transfer_dictionary_token UNIQUE(chain,token_address),
    CONSTRAINT rh_transfer_dictionary_bound CHECK (ordinal BETWEEN 0 AND 999999)
  )`,
  `CREATE OR REPLACE FUNCTION rh_transfer_dictionary_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'transfer scope dictionary is immutable'; END $$`,
  `DROP TRIGGER IF EXISTS rh_transfer_dictionary_immutable ON robinhood_wallet_transfer_scope_dictionary`,
  `CREATE TRIGGER rh_transfer_dictionary_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
    ON robinhood_wallet_transfer_scope_dictionary FOR EACH STATEMENT EXECUTE FUNCTION rh_transfer_dictionary_immutable()`,
  `ALTER TABLE robinhood_wallet_transfer_token_scopes
    ADD COLUMN IF NOT EXISTS scope_bitmap BYTEA,
    ADD COLUMN IF NOT EXISTS dictionary_size INTEGER,
    ADD COLUMN IF NOT EXISTS bitmap_token_count INTEGER`,
  `ALTER TABLE robinhood_wallet_transfer_token_scopes ALTER COLUMN token_addresses DROP NOT NULL`,
  `ALTER TABLE robinhood_wallet_transfer_token_scopes DROP CONSTRAINT IF EXISTS rh_transfer_scope_bitmap_payload`,
  `ALTER TABLE robinhood_wallet_transfer_token_scopes ADD CONSTRAINT rh_transfer_scope_bitmap_payload CHECK (
    (scope_bitmap IS NULL AND dictionary_size IS NULL AND bitmap_token_count IS NULL AND token_addresses IS NOT NULL)
    OR (scope_bitmap IS NOT NULL AND dictionary_size IS NOT NULL AND bitmap_token_count IS NOT NULL
      AND dictionary_size BETWEEN 1 AND 1000000 AND bitmap_token_count BETWEEN 1 AND 500000
      AND octet_length(scope_bitmap)=(dictionary_size+7)/8 AND bit_count(scope_bitmap)=bitmap_token_count
      AND CASE WHEN dictionary_size%8<>0 AND octet_length(scope_bitmap)>0
        THEN get_byte(scope_bitmap,octet_length(scope_bitmap)-1)<power(2,dictionary_size%8) ELSE true END
      AND (token_addresses IS NULL OR cardinality(token_addresses)=bitmap_token_count))) NOT VALID`,
  `CREATE OR REPLACE FUNCTION rh_transfer_bitmap_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.scope_bitmap IS NOT NULL AND (
      ROW(NEW.chain,NEW.scope_hash,NEW.scope_bitmap,NEW.dictionary_size,NEW.bitmap_token_count)
        IS DISTINCT FROM ROW(OLD.chain,OLD.scope_hash,OLD.scope_bitmap,OLD.dictionary_size,OLD.bitmap_token_count)
      OR (NEW.token_addresses IS NOT NULL AND NEW.token_addresses IS DISTINCT FROM OLD.token_addresses))
      THEN RAISE EXCEPTION 'published transfer scope bitmap is immutable'; END IF; RETURN NEW; END $$`,
  `DROP TRIGGER IF EXISTS rh_transfer_bitmap_immutable ON robinhood_wallet_transfer_token_scopes`,
  `CREATE TRIGGER rh_transfer_bitmap_immutable BEFORE UPDATE ON robinhood_wallet_transfer_token_scopes
    FOR EACH ROW EXECUTE FUNCTION rh_transfer_bitmap_immutable()`,
  `CREATE INDEX IF NOT EXISTS idx_rh_transfer_scope_bitmaps ON robinhood_wallet_transfer_token_scopes(chain,scope_hash)
    WHERE token_addresses IS NULL AND scope_bitmap IS NOT NULL`,
]);
async function init(options = {}) {
  const client = await (options.database || db).getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await (options.database || db).pool.end();
  }
}
if (require.main === module) init().catch((error) => {
  console.error('Stage 262 transfer scope bitmaps failed:', error.message); process.exitCode = 1;
});
module.exports = { STATEMENTS, init };
