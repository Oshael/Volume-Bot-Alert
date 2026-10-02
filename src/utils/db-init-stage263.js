'use strict';
const db = require('../models/db');
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_transfer_scope_bitmap_staging (
    chain VARCHAR(32) NOT NULL CHECK (chain='robinhood'),
    scope_hash VARCHAR(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
    scope_bitmap BYTEA NOT NULL,
    dictionary_size INTEGER NOT NULL,
    bitmap_token_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT rh_transfer_bitmap_staging_pkey PRIMARY KEY(chain,scope_hash),
    CONSTRAINT rh_transfer_bitmap_staging_payload CHECK (
      dictionary_size BETWEEN 1 AND 1000000 AND bitmap_token_count BETWEEN 1 AND 500000
      AND octet_length(scope_bitmap)=(dictionary_size+7)/8 AND bit_count(scope_bitmap)=bitmap_token_count
      AND CASE WHEN dictionary_size%8<>0 AND octet_length(scope_bitmap)>0
        THEN get_byte(scope_bitmap,octet_length(scope_bitmap)-1)<power(2,dictionary_size%8) ELSE true END)
  )`,
  `CREATE OR REPLACE FUNCTION rh_transfer_bitmap_staging_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'prepared transfer scope bitmap is immutable'; END $$`,
  `DROP TRIGGER IF EXISTS rh_transfer_bitmap_staging_immutable ON robinhood_wallet_transfer_scope_bitmap_staging`,
  `CREATE TRIGGER rh_transfer_bitmap_staging_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
    ON robinhood_wallet_transfer_scope_bitmap_staging FOR EACH STATEMENT
    EXECUTE FUNCTION rh_transfer_bitmap_staging_immutable()`,
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
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end();
  }
}
if (require.main === module) init().catch((error) => {
  console.error('Stage 263 transfer scope staging failed:', error.message); process.exitCode = 1;
});
module.exports = { STATEMENTS, init };
