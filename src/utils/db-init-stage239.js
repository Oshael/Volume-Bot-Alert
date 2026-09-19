'use strict';

/** Stage 239 - durable coverage for the compact stock/USD reference journal. */
const db = require('../models/db');

const TABLE = 'robinhood_stock_usd_reference_coverage';
const CONSTRAINT = 'rh_stock_usd_reference_coverage_values_check';
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     coverage_start_block BIGINT NOT NULL,
     next_block BIGINT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_stock_usd_reference_coverage_pkey PRIMARY KEY (chain),
     CONSTRAINT ${CONSTRAINT} CHECK (
       chain='robinhood' AND coverage_start_block>=0
       AND next_block>coverage_start_block
     )
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then(() => {
  console.log('Stage 239 stock/USD reference coverage created successfully');
}).catch((error) => {
  console.error('Failed to apply Stage 239:', error.message);
  process.exitCode = 1;
});

module.exports = { CONSTRAINT, STATEMENTS, TABLE, init };
