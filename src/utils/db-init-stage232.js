'use strict';

/** Stage 232 - durable Robinhood holder legacy coverage manifest and capture policy. */
const db = require('../models/db');

const GENERATION_CONSTRAINT = 'rh_holder_token_states_coverage_generation_check';
const POLICY_TABLE = 'robinhood_holder_capture_policy';
const MANIFEST_TABLE = 'robinhood_holder_legacy_coverage_manifest';
const INVALIDATION_FUNCTION = 'invalidate_robinhood_holder_legacy_coverage';
const INVALIDATION_TRIGGER = 'trg_rh_holder_legacy_coverage_invalidation';

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_token_states
     ADD COLUMN IF NOT EXISTS coverage_generation BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE robinhood_holder_token_states
     DROP CONSTRAINT IF EXISTS ${GENERATION_CONSTRAINT},
     ADD CONSTRAINT ${GENERATION_CONSTRAINT}
       CHECK (coverage_generation >= 0) NOT VALID`,
  `ALTER TABLE robinhood_holder_token_states
     VALIDATE CONSTRAINT ${GENERATION_CONSTRAINT}`,
  `CREATE TABLE IF NOT EXISTS ${POLICY_TABLE} (
     chain VARCHAR(16) PRIMARY KEY DEFAULT 'robinhood',
     capture_mode VARCHAR(16) NOT NULL DEFAULT 'legacy',
     coverage_generation BIGINT NOT NULL DEFAULT 0,
     cutover_next_block BIGINT,
     cutover_checkpoint_block BIGINT,
     cutover_checkpoint_hash VARCHAR(66),
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_capture_policy_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_capture_policy_mode_check
       CHECK (capture_mode IN ('legacy', 'tracked')),
     CONSTRAINT rh_holder_capture_policy_generation_check
       CHECK (coverage_generation >= 0 AND version >= 0),
     CONSTRAINT rh_holder_capture_policy_cutover_check CHECK (
       (capture_mode = 'legacy' AND cutover_next_block IS NULL
         AND cutover_checkpoint_block IS NULL AND cutover_checkpoint_hash IS NULL)
       OR (capture_mode = 'tracked' AND coverage_generation > 0
         AND cutover_next_block IS NOT NULL AND cutover_checkpoint_block IS NOT NULL
         AND cutover_checkpoint_hash IS NOT NULL
         AND cutover_next_block = cutover_checkpoint_block + 1
         AND cutover_checkpoint_block >= 0
         AND cutover_checkpoint_hash ~ '^0x[0-9a-f]{64}$')
     )
   )`,
  `INSERT INTO ${POLICY_TABLE} (chain) VALUES ('robinhood')
   ON CONFLICT (chain) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     token_address VARCHAR(42) NOT NULL,
     coverage_generation BIGINT NOT NULL,
     baseline_status VARCHAR(16) NOT NULL,
     baseline_deployment_block BIGINT NOT NULL,
     baseline_backfill_next_block BIGINT NOT NULL,
     baseline_live_through_block BIGINT,
     baseline_live_through_hash VARCHAR(66),
     baseline_holder_count BIGINT NOT NULL,
     prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_holder_legacy_manifest_pkey PRIMARY KEY (chain, token_address),
     CONSTRAINT rh_holder_legacy_manifest_state_fkey
       FOREIGN KEY (chain, token_address)
       REFERENCES robinhood_holder_token_states(chain, token_address) ON DELETE RESTRICT,
     CONSTRAINT rh_holder_legacy_manifest_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_holder_legacy_manifest_token_check
       CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
     CONSTRAINT rh_holder_legacy_manifest_status_check
       CHECK (baseline_status IN ('shadow', 'live')),
     CONSTRAINT rh_holder_legacy_manifest_blocks_check CHECK (
       coverage_generation > 0 AND baseline_deployment_block >= 0
       AND baseline_backfill_next_block >= baseline_deployment_block
       AND baseline_holder_count >= 0
     ),
     CONSTRAINT rh_holder_legacy_manifest_checkpoint_check CHECK (
       (baseline_live_through_block IS NULL) = (baseline_live_through_hash IS NULL)
       AND (baseline_live_through_block IS NULL OR (
         baseline_live_through_block >= baseline_deployment_block
         AND baseline_live_through_hash ~ '^0x[0-9a-f]{64}$'))
       AND (baseline_status <> 'live' OR baseline_live_through_block IS NOT NULL)
       AND (baseline_live_through_block IS NOT NULL OR (
         baseline_status = 'shadow' AND baseline_holder_count = 0
         AND baseline_backfill_next_block = baseline_deployment_block))
     )
   )`,
  `CREATE OR REPLACE FUNCTION ${INVALIDATION_FUNCTION}()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF (OLD.ledger_status IN ('shadow', 'live')
         AND NEW.ledger_status NOT IN ('shadow', 'live'))
        OR NEW.deployment_block IS DISTINCT FROM OLD.deployment_block
        OR (OLD.ledger_status IN ('shadow', 'live')
          AND NEW.backfill_next_block IS DISTINCT FROM OLD.backfill_next_block) THEN
       NEW.coverage_generation := OLD.coverage_generation + 1;
     END IF;
     RETURN NEW;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS ${INVALIDATION_TRIGGER} ON robinhood_holder_token_states`,
  `CREATE TRIGGER ${INVALIDATION_TRIGGER}
   BEFORE UPDATE OF ledger_status, deployment_block, backfill_next_block
   ON robinhood_holder_token_states FOR EACH ROW
   EXECUTE FUNCTION ${INVALIDATION_FUNCTION}()`,
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
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
    console.log('Stage 232 Robinhood holder legacy coverage schema created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 232:', error.message);
  process.exitCode = 1;
});

module.exports = {
  GENERATION_CONSTRAINT, INVALIDATION_FUNCTION, INVALIDATION_TRIGGER,
  MANIFEST_TABLE, POLICY_TABLE, STATEMENTS, init,
};
