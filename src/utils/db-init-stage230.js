'use strict';

/** Stage 230 - ordered publication claims for audited wallet-swap lifecycle events. */
const db = require('../models/db');

const INDEX_NAME = 'idx_rh_wallet_swap_realtime_outbox_publication_claim_ordered';
const CREATE_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON robinhood_wallet_swap_realtime_outbox (
    block_number, transaction_index, log_index,
    (CASE event_kind WHEN 'observed' THEN 0 WHEN 'finalized' THEN 1 ELSE 2 END),
    next_attempt_at
  ) WHERE chain='robinhood' AND status='pending' AND audit_status='complete'`;

async function init(options = {}) {
  const database = options.database || db;
  try {
    const current = await database.query(
      'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
      [INDEX_NAME]
    );
    if (current.rows[0] && (!current.rows[0].indisvalid || !current.rows[0].indisready)) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
    }
    await database.query(CREATE_STATEMENT);
    const ready = await database.query(
      'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
      [INDEX_NAME]
    );
    if (!ready.rows[0]?.indisvalid || !ready.rows[0]?.indisready) {
      throw new Error(`Stage 230 index is not ready: ${INDEX_NAME}`);
    }
    console.log('Stage 230 Robinhood wallet-swap publication claim index created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 230:', error.message);
  process.exitCode = 1;
});

module.exports = { CREATE_STATEMENT, INDEX_NAME, init };
