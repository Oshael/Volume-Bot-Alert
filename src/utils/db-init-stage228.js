'use strict';

/** Stage 228 - durable authority for Robinhood head lifecycle processing. */
const db = require('../models/db');

const TABLE_NAME = 'robinhood_head_processing_authority';
const FUNCTION_NAME = 'protect_robinhood_head_processing_authority';
const TRIGGER_NAME = 'rh_head_processing_authority_guard';

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
     chain VARCHAR(16) PRIMARY KEY DEFAULT 'robinhood',
     authority VARCHAR(16) NOT NULL DEFAULT 'legacy',
     generation BIGINT NOT NULL DEFAULT 0,
     activated_at TIMESTAMPTZ,
     activation_report JSONB,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_head_processing_authority_values_check CHECK (
       chain = 'robinhood' AND authority IN ('legacy', 'state') AND generation >= 0
     ),
     CONSTRAINT rh_head_processing_authority_activation_check CHECK (
       authority = 'legacy' OR (activated_at IS NOT NULL AND activation_report IS NOT NULL)
     )
   )`,
  `INSERT INTO ${TABLE_NAME} (chain, authority)
   VALUES ('robinhood', 'legacy') ON CONFLICT (chain) DO NOTHING`,
  `CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
   RETURNS TRIGGER LANGUAGE plpgsql
   SET search_path = pg_catalog, public
   AS $function$
   BEGIN
     IF OLD.authority = 'state' AND NEW.authority <> 'state' THEN
       RAISE EXCEPTION 'state authority requires audited reconciliation before rollback';
     END IF;
     IF OLD.authority = 'legacy' AND NEW.authority = 'state' THEN
       IF NEW.generation <> OLD.generation + 1
          OR NEW.activated_at IS NULL OR NEW.activation_report IS NULL THEN
         RAISE EXCEPTION 'state authority activation requires generation and audit report';
       END IF;
       RETURN NEW;
     END IF;
     IF ROW(OLD.chain, OLD.authority, OLD.generation, OLD.activated_at, OLD.activation_report)
        IS DISTINCT FROM
        ROW(NEW.chain, NEW.authority, NEW.generation, NEW.activated_at, NEW.activation_report) THEN
       RAISE EXCEPTION 'head processing authority history is immutable';
     END IF;
     RETURN NEW;
   END
   $function$`,
  `DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON ${TABLE_NAME}`,
  `CREATE TRIGGER ${TRIGGER_NAME}
     BEFORE UPDATE ON ${TABLE_NAME}
     FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}()`,
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
    } finally {
      client.release();
    }
    console.log('Stage 228 Robinhood head processing authority created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 228:', error.message);
  process.exitCode = 1;
});

module.exports = {
  FUNCTION_NAME, STATEMENTS, TABLE_NAME, TRIGGER_NAME, init,
};
