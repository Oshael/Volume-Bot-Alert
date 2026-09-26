'use strict';

/** Stage 234 - central holder coverage fence for tracked-only capture. */
const db = require('../models/db');

const FUNCTION_NAME = 'enforce_robinhood_holder_coverage_contract';
const TRIGGER_NAME = 'trg_rh_holder_zz_coverage_guard';
const STATEMENTS = Object.freeze([
  `CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
   RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     effective_mode VARCHAR(16);
     live_next_block BIGINT;
     live_journal_floor_block BIGINT;
     needs_cursor_fence BOOLEAN := FALSE;
   BEGIN
     IF NEW.chain <> 'robinhood'
        OR NEW.ledger_status NOT IN ('backfilling', 'shadow', 'live') THEN
       RETURN NEW;
     END IF;

     IF TG_OP = 'UPDATE' THEN
       IF NEW.ledger_status IS NOT DISTINCT FROM OLD.ledger_status
          AND NEW.tail_capture_from_block IS NOT DISTINCT FROM OLD.tail_capture_from_block
          AND NEW.coverage_generation IS NOT DISTINCT FROM OLD.coverage_generation
          AND (NEW.ledger_status NOT IN ('shadow', 'live') OR (
            NEW.deployment_block IS NOT DISTINCT FROM OLD.deployment_block
            AND NEW.backfill_next_block IS NOT DISTINCT FROM OLD.backfill_next_block)) THEN
         RETURN NEW;
       END IF;
       needs_cursor_fence := OLD.ledger_status NOT IN ('backfilling', 'shadow', 'live')
         OR NEW.tail_capture_from_block IS DISTINCT FROM OLD.tail_capture_from_block;
     ELSE
       needs_cursor_fence := TRUE;
     END IF;

     IF needs_cursor_fence THEN
       SELECT next_block, journal_floor_block
         INTO live_next_block, live_journal_floor_block
         FROM robinhood_holder_cursors
        WHERE chain = NEW.chain AND stream = 'live' FOR SHARE;
       IF live_next_block IS NULL THEN
         RAISE EXCEPTION 'Robinhood holder live cursor is missing'
           USING ERRCODE = '23514', CONSTRAINT = 'rh_holder_coverage_contract_guard';
       END IF;
     END IF;

     SELECT capture_mode INTO effective_mode
       FROM robinhood_holder_capture_policy
      WHERE chain = NEW.chain FOR SHARE;
     IF effective_mode IS NULL THEN
       RAISE EXCEPTION 'Robinhood holder capture policy is missing'
         USING ERRCODE = '23514', CONSTRAINT = 'rh_holder_coverage_contract_guard';
     END IF;
     IF effective_mode = 'legacy' THEN RETURN NEW; END IF;

     IF NEW.ledger_status IN ('shadow', 'live')
        AND NEW.tail_capture_from_block IS NULL
        AND EXISTS (
          SELECT 1 FROM robinhood_holder_legacy_coverage_manifest manifest
           WHERE manifest.chain = NEW.chain
             AND manifest.token_address = NEW.token_address
             AND manifest.coverage_generation = NEW.coverage_generation
        ) THEN
       RETURN NEW;
     END IF;
     IF NEW.tail_capture_from_block IS NULL THEN
       RAISE EXCEPTION 'Robinhood holder state has no current coverage contract'
         USING ERRCODE = '23514', CONSTRAINT = 'rh_holder_coverage_contract_guard';
     END IF;

     IF needs_cursor_fence THEN
       IF NEW.tail_capture_from_block < live_next_block THEN
         IF TG_OP <> 'INSERT' OR NEW.ledger_status <> 'backfilling'
            OR live_journal_floor_block IS NULL
            OR NOT EXISTS (
              SELECT 1
                FROM robinhood_holder_global_backfill_tokens token
                JOIN robinhood_holder_global_backfill_runs run
                  ON run.id = token.run_id AND run.chain = token.chain
               WHERE token.chain = NEW.chain
                 AND token.token_address = NEW.token_address
                 AND token.status = 'active'
                 AND run.status IN ('attached', 'materializing')
                 AND run.barrier_block = NEW.tail_capture_from_block
                 AND run.next_block = run.barrier_block
                 AND run.checkpoint_block = run.barrier_checkpoint_block
                 AND run.checkpoint_hash = run.barrier_checkpoint_hash
                 AND NEW.backfill_next_block = run.barrier_block
                 AND NEW.live_through_block = run.barrier_checkpoint_block
                 AND NEW.live_through_hash = run.barrier_checkpoint_hash
                 AND NEW.holder_count = token.holder_count
                 AND run.barrier_block >= live_journal_floor_block
            ) THEN
           RAISE EXCEPTION 'Robinhood holder tail is behind the locked live cursor'
             USING ERRCODE = '23514', CONSTRAINT = 'rh_holder_coverage_contract_guard';
         END IF;
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON robinhood_holder_token_states`,
  `CREATE TRIGGER ${TRIGGER_NAME}
   BEFORE INSERT OR UPDATE OF ledger_status, tail_capture_from_block,
     coverage_generation, deployment_block, backfill_next_block
   ON robinhood_holder_token_states FOR EACH ROW
   EXECUTE FUNCTION ${FUNCTION_NAME}()`,
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
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then(() => {
  console.log('Stage 234 Robinhood holder coverage guard created successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 234:', error.message);
  process.exitCode = 1;
});

module.exports = { FUNCTION_NAME, STATEMENTS, TRIGGER_NAME, init };
