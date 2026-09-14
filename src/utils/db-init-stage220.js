'use strict';

/** Stage 220 - bounded, ordered wallet-swap lifecycle audit claims. */
const db = require('../models/db');
const stage209 = require('./db-init-stage209');

const INDEX_NAME = stage209.INDEX_NAMES[0];
const LEGACY_INDEX_NAME = 'idx_rh_wallet_swap_realtime_outbox_audit_claim';
const CREATE_STATEMENT = stage209.STATEMENTS[2];

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
      throw new Error(`Stage 220 index is not ready: ${INDEX_NAME}`);
    }
    await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_INDEX_NAME}`);
    console.log('Stage 220 Robinhood wallet-swap audit claim index created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 220:', error.message);
  process.exitCode = 1;
});

module.exports = { CREATE_STATEMENT, INDEX_NAME, LEGACY_INDEX_NAME, init };
