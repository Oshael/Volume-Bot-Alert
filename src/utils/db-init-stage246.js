'use strict';

/** Stage 246 - invalidate funding only when its early candidate inputs change. */
const db = require('../models/db');
const { ENQUEUE_FUNCTION_STATEMENT } = require('./db-init-stage172');

const STATEMENTS = Object.freeze([
  ENQUEUE_FUNCTION_STATEMENT,
  `CREATE OR REPLACE FUNCTION enqueue_robinhood_bundle_funding_first_buy()
   RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
   DECLARE
     affected_token VARCHAR(42);
     previous_block BIGINT;
     current_block BIGINT;
   BEGIN
     IF TG_OP = 'INSERT' THEN
       affected_token := NEW.token_address;
       current_block := NEW.block_number;
     ELSIF TG_OP = 'DELETE' THEN
       affected_token := OLD.token_address;
       previous_block := OLD.block_number;
     ELSE
       affected_token := NEW.token_address;
       previous_block := OLD.block_number;
       current_block := NEW.block_number;
     END IF;
     UPDATE robinhood_bundle_funding_live_queue queue SET
       requested_version = queue.requested_version + 1,
       status = 'pending', lease_owner = NULL, lease_until = NULL,
       next_attempt_at = NOW(), last_error_code = NULL,
       last_error_message = NULL, completed_at = NULL, updated_at = NOW()
       FROM robinhood_token_launch_anchors anchor
      WHERE queue.chain = 'robinhood' AND queue.token_address = affected_token
        AND anchor.chain = queue.chain AND anchor.token_address = queue.token_address
        AND (previous_block BETWEEN anchor.launch_block AND anchor.launch_block + 3
          OR current_block BETWEEN anchor.launch_block AND anchor.launch_block + 3);
     IF FOUND THEN
       PERFORM pg_notify('robinhood_bundle_funding_live_queue', affected_token);
     END IF;
     RETURN NULL;
   END
   $trigger$`,
  `DROP TRIGGER IF EXISTS rh_first_buy_bundle_funding_live
     ON robinhood_wallet_token_first_buys`,
  `CREATE TRIGGER rh_first_buy_bundle_funding_live
     AFTER INSERT OR UPDATE OR DELETE ON robinhood_wallet_token_first_buys
     FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_bundle_funding_first_buy()`,
]);

async function init(options = {}) {
  const database = options.database || db;
  let client;
  try {
    client = await database.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query('COMMIT');
    console.log('Stage 246 bundle-funding invalidation created successfully');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 246:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
