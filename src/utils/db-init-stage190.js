'use strict';

/** Stage 190 - retire indexes unused by the current Solana and Robinhood reads. */
const db = require('../models/db');

const INDEX_NAMES = Object.freeze([
  'idx_token_market_buckets_1m_sparkline_cover',
  'idx_token_market_buckets_1m_chain_sparkline_cover',
  'idx_robinhood_processed_logs_market',
  'idx_robinhood_processed_logs_block',
]);
const STATEMENTS = Object.freeze(INDEX_NAMES.map(
  (indexName) => `DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`
));

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 190 unused market indexes retired successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to retire Stage 190 market indexes:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAMES, STATEMENTS, init };
