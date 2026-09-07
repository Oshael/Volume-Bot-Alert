'use strict';

/** Stage 201 - make canonical event retention cascades index-backed. */
const db = require('../models/db');

const INDEXES = Object.freeze([
  Object.freeze({
    name: 'idx_rh_chain_domain_outbox_event_lookup',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_rh_chain_domain_outbox_event_lookup
      ON robinhood_chain_domain_outbox (block_hash, log_index)`,
  }),
  Object.freeze({
    name: 'idx_rh_canonical_head_candidates_event_lookup',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS
      idx_rh_canonical_head_candidates_event_lookup
      ON robinhood_canonical_head_candidates (block_hash, log_index)`,
  }),
]);
const STATEMENTS = Object.freeze(INDEXES.map(({ statement }) => statement));

async function inspectIndex(database, indexName) {
  const result = await database.query(
    `SELECT indisvalid, indisready
       FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [indexName]
  );
  return result.rows[0] || null;
}

async function ensureIndex(database, index) {
  const existing = await inspectIndex(database, index.name);
  if (existing && (!existing.indisvalid || !existing.indisready)) {
    await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
  }
  await database.query(index.statement);
  const ready = await inspectIndex(database, index.name);
  if (!ready?.indisvalid || !ready?.indisready) {
    throw new Error(`${index.name} is not valid/ready`);
  }
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const index of INDEXES) await ensureIndex(database, index);
    console.log('Stage 201 Robinhood event cascade indexes created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 201:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEXES, STATEMENTS, ensureIndex, init, inspectIndex };
