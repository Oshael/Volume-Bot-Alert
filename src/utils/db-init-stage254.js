'use strict';

/** Stage 254 - record V3 balance read outcomes without revising captured events. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_chain_v3_balance_snapshots
     ADD COLUMN IF NOT EXISTS balance_status TEXT NOT NULL DEFAULT 'observed'`,
  `ALTER TABLE robinhood_chain_v3_balance_snapshots
     ALTER COLUMN token_balance_raw DROP NOT NULL,
     ALTER COLUMN quote_balance_raw DROP NOT NULL`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint
       WHERE conname='rh_chain_v3_balance_status_check'
         AND conrelid='robinhood_chain_v3_balance_snapshots'::regclass) THEN
       ALTER TABLE robinhood_chain_v3_balance_snapshots
         ADD CONSTRAINT rh_chain_v3_balance_status_check CHECK (
           (balance_status='observed'
             AND token_balance_raw IS NOT NULL AND quote_balance_raw IS NOT NULL)
           OR (balance_status IN ('skipped_window', 'historical_unavailable', 'balance_failed')
             AND token_balance_raw IS NULL AND quote_balance_raw IS NULL)
         ) NOT VALID;
     END IF;
   END
   $migration$`,
]);

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query('COMMIT');
    console.log('Stage 254 Robinhood V3 balance outcomes created successfully');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 254:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
