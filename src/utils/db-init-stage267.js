'use strict';
const db = require('../models/db');
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_holder_admission_queue (
    chain varchar(32) NOT NULL CHECK (chain='robinhood'),
    token_address varchar(42) NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    lease_owner varchar(128), lease_until timestamptz, last_error varchar(500),
    created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chain, token_address),
    CONSTRAINT rh_holder_admission_lease_check CHECK (
      (status='pending' AND lease_owner IS NULL AND lease_until IS NULL) OR
      (status='leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)))`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_admission_due
    ON robinhood_holder_admission_queue (next_attempt_at, token_address) WHERE status='pending'`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_admission_expired
    ON robinhood_holder_admission_queue (lease_until) WHERE status='leased'`,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_holder_admission() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    DECLARE item jsonb; address text;
    BEGIN
      IF TG_OP='DELETE' THEN item=to_jsonb(OLD); ELSE item=to_jsonb(NEW); END IF;
      IF TG_OP='UPDATE' AND
        (item->'source',item->'attribution_block',item->'attribution_tx_hash',
          item->'creator_address',item->'attribution_factory_address') IS NOT DISTINCT FROM
        (to_jsonb(OLD)->'source',to_jsonb(OLD)->'attribution_block',to_jsonb(OLD)->'attribution_tx_hash',
          to_jsonb(OLD)->'creator_address',to_jsonb(OLD)->'attribution_factory_address') THEN
        RETURN NULL;
      END IF;
      address=COALESCE(item->>'token_address', item->>'address');
      IF item->>'chain'='robinhood' AND address ~ '^0x[0-9a-f]{40}$'
        AND address<>'0x0000000000000000000000000000000000000000' AND NOT EXISTS (
        SELECT 1 FROM robinhood_holder_token_states
        WHERE chain='robinhood' AND token_address=address) THEN
        INSERT INTO robinhood_holder_admission_queue (chain,token_address)
        VALUES ('robinhood',address) ON CONFLICT (chain,token_address) DO UPDATE SET
          version=robinhood_holder_admission_queue.version+1, attempt_count=0,
          next_attempt_at=NOW(), updated_at=NOW();
        PERFORM pg_notify('robinhood_holder_admission',address);
      END IF;
      RETURN NULL;
    END $body$`,
  `DROP TRIGGER IF EXISTS rh_holder_admission_catalog ON token_catalog`,
  `CREATE TRIGGER rh_holder_admission_catalog AFTER INSERT ON token_catalog
    FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_holder_admission()`,
  `DROP TRIGGER IF EXISTS rh_holder_admission_proof ON robinhood_token_attributions`,
  `CREATE TRIGGER rh_holder_admission_proof AFTER INSERT OR UPDATE OF source, attribution_block,
    attribution_tx_hash, creator_address, attribution_factory_address ON robinhood_token_attributions
    FOR EACH ROW WHEN (NEW.attribution_block IS NOT NULL AND NEW.source IN
      ('rpc_direct','rpc_trace','rpc_code_transition','blockscout_internal','launchpad_event'))
    EXECUTE FUNCTION enqueue_robinhood_holder_admission()`,
  `DROP TRIGGER IF EXISTS rh_holder_admission_unblock ON admin_blocked_tokens`,
  `CREATE TRIGGER rh_holder_admission_unblock AFTER DELETE ON admin_blocked_tokens
    FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_holder_admission()`,
  `DROP TRIGGER IF EXISTS rh_holder_admission_reset ON robinhood_holder_token_states`,
  `CREATE TRIGGER rh_holder_admission_reset AFTER DELETE ON robinhood_holder_token_states
    FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_holder_admission()`,
]);
async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='1s'");
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
  console.error('Stage 267 holder admission queue failed:', error.message);
  process.exitCode = 1;
});
module.exports = { STATEMENTS, init };
