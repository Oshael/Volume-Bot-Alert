'use strict';

/** Stage 217 - indexed Robinhood token catalog text discovery. */
const db = require('../models/db');

const INDEX_NAMES = Object.freeze([
  'idx_token_catalog_robinhood_symbol_search',
  'idx_token_catalog_robinhood_name_search',
  'idx_token_catalog_robinhood_text_search',
]);
const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[0]}
     ON token_catalog (LOWER(symbol) text_pattern_ops, address)
     WHERE chain='robinhood' AND symbol IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[1]}
     ON token_catalog (LOWER(name) text_pattern_ops, address)
     WHERE chain='robinhood' AND name IS NOT NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAMES[2]}
     ON token_catalog USING GIN (
       to_tsvector('simple', COALESCE(symbol, '') || ' ' || COALESCE(name, ''))
     ) WHERE chain='robinhood'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 217 Robinhood catalog search indexes created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 217:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAMES, STATEMENTS, init };
