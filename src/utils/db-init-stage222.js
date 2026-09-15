'use strict';

/** Stage 222 - bounded stock/USD journal tail lookups for pruned-state recovery. */
const db = require('../models/db');
const v2 = require('../services/uniswap-v2-decoder');
const v3 = require('../services/uniswap-v3-decoder');
const v4 = require('../services/uniswap-v4-decoder');

const INDEX_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'idx_rh_chain_events_v2_v3_pool_tail',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_chain_events_v2_v3_pool_tail
      ON robinhood_chain_events(
        chain, address, topic0, block_number DESC, transaction_index DESC, log_index DESC
      ) WHERE topic0 IN ('${v2.TOPICS.sync}', '${v3.TOPICS.swap}')`,
  }),
  Object.freeze({
    name: 'idx_rh_chain_events_v4_pool_tail',
    statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rh_chain_events_v4_pool_tail
      ON robinhood_chain_events(
        chain, address, topic0, (topics ->> 1), block_number DESC,
        transaction_index DESC, log_index DESC
      ) WHERE topic0 = '${v4.TOPICS.swap}'`,
  }),
]);
const INDEX_NAMES = Object.freeze(INDEX_DEFINITIONS.map(({ name }) => name));
const STATEMENTS = Object.freeze(INDEX_DEFINITIONS.map(({ statement }) => statement));

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const definition of INDEX_DEFINITIONS) {
      const current = await database.query(
        'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
        [definition.name]
      );
      if (current.rows[0] && (!current.rows[0].indisvalid || !current.rows[0].indisready)) {
        await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${definition.name}`);
      }
      await database.query(definition.statement);
      const ready = await database.query(
        'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
        [definition.name]
      );
      if (!ready.rows[0]?.indisvalid || !ready.rows[0]?.indisready) {
        throw new Error(`Stage 222 index is not ready: ${definition.name}`);
      }
    }
    console.log('Stage 222 Robinhood stock/USD journal indexes created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 222:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_DEFINITIONS, INDEX_NAMES, STATEMENTS, init };
