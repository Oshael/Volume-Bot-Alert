/**
 * Stage 70 - Global Robinhood bucket time indexes for bounded token reads.
 * Keys intentionally exclude mutable metrics so active bucket updates can
 * remain HOT when PostgreSQL has room on the heap page.
 * Run with: node src/utils/db-init-stage70.js
 */
const db = require('../models/db');

const INDEXES = Object.freeze([
  Object.freeze({
    name: 'idx_robinhood_market_buckets_1m_global_time',
    table: 'robinhood_market_buckets_1m',
  }),
  Object.freeze({
    name: 'idx_robinhood_market_buckets_1h_global_time',
    table: 'robinhood_market_buckets_1h',
  }),
]);

const STATEMENTS = Object.freeze(INDEXES.map(({ name, table }) => (
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
     ON ${table}(chain, bucket_ts DESC, token_address, protocol, market_key)`
)));

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 70 Robinhood global bucket time indexes created successfully');
  } catch (error) {
    console.error('Failed to create stage 70 Robinhood bucket time indexes:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { INDEXES, STATEMENTS, init };
