'use strict';

/** Stage 235 - durable per-block receipts for bounded holder cutover evidence. */
const db = require('../models/db');

const TABLE_NAME = 'robinhood_holder_capture_receipts';
const IMMUTABILITY_FUNCTION = 'enforce_robinhood_holder_journal_evidence_immutable';
const IMMUTABILITY_TRIGGER = 'trg_rh_holder_journal_evidence_immutable';
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transfer_count INTEGER NOT NULL,
     evidence_hash VARCHAR(66) NOT NULL,
     capture_policy_version BIGINT NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_capture_receipts_pkey PRIMARY KEY (chain, block_number),
     CONSTRAINT rh_holder_capture_receipts_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_capture_receipts_values_check CHECK (
       block_number >= 0 AND transfer_count > 0 AND capture_policy_version >= 0
       AND block_hash ~ '^0x[0-9a-f]{64}$'
       AND evidence_hash ~ '^0x[0-9a-f]{64}$'
     )
   )`,
  `CREATE OR REPLACE FUNCTION ${IMMUTABILITY_FUNCTION}()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.chain IS DISTINCT FROM OLD.chain
        OR NEW.block_number IS DISTINCT FROM OLD.block_number
        OR NEW.block_hash IS DISTINCT FROM OLD.block_hash
        OR NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash
        OR NEW.transaction_index IS DISTINCT FROM OLD.transaction_index
        OR NEW.log_index IS DISTINCT FROM OLD.log_index
        OR NEW.token_address IS DISTINCT FROM OLD.token_address
        OR NEW.from_wallet IS DISTINCT FROM OLD.from_wallet
        OR NEW.to_wallet IS DISTINCT FROM OLD.to_wallet
        OR NEW.amount_raw IS DISTINCT FROM OLD.amount_raw THEN
       RAISE EXCEPTION 'Robinhood holder journal evidence is immutable'
         USING ERRCODE = '23514', CONSTRAINT = 'rh_holder_journal_evidence_immutable';
     END IF;
     RETURN NEW;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS ${IMMUTABILITY_TRIGGER}
     ON robinhood_holder_transfer_journal`,
  `CREATE TRIGGER ${IMMUTABILITY_TRIGGER}
   BEFORE UPDATE OF chain, block_number, block_hash, transaction_hash, transaction_index,
     log_index, token_address, from_wallet, to_wallet, amount_raw
   ON robinhood_holder_transfer_journal FOR EACH ROW
   EXECUTE FUNCTION ${IMMUTABILITY_FUNCTION}()`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      for (const statement of STATEMENTS) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then(() => {
  console.log('Stage 235 Robinhood holder capture receipts created successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 235:', error.message);
  process.exitCode = 1;
});

module.exports = {
  IMMUTABILITY_FUNCTION, IMMUTABILITY_TRIGGER, STATEMENTS, TABLE_NAME, init,
};
