'use strict';

/** Stage 222 - compact durable stock/USD reference event journal. */
const db = require('../models/db');

const TABLE = 'robinhood_stock_usd_reference_events';
const INDEX_NAME = 'idx_rh_stock_usd_reference_events_canonical_lookup';
const LEGACY_INDEX_NAMES = Object.freeze([
  'idx_rh_chain_events_v2_v3_pool_tail',
  'idx_rh_chain_events_v4_pool_tail',
  'idx_rh_stock_usd_reference_events_lookup',
]);
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_weth_usd_reference_pools (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     pool_address VARCHAR(42) NOT NULL,
     fee INTEGER NOT NULL,
     deployment_block BIGINT NOT NULL,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_weth_usd_reference_pools_pkey PRIMARY KEY (chain, pool_address),
     CONSTRAINT rh_weth_usd_reference_pools_values_check CHECK (
       chain='robinhood' AND pool_address ~ '^0x[0-9a-f]{40}$'
       AND fee IN (100,500,3000,10000) AND deployment_block>=0
     )
   )`,
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     protocol VARCHAR(24) NOT NULL,
     market_key VARCHAR(160) NOT NULL,
     stock_address VARCHAR(42) NOT NULL,
     block_number BIGINT NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     transaction_index INTEGER NOT NULL,
     log_index INTEGER NOT NULL,
     address VARCHAR(42) NOT NULL,
     topics JSONB NOT NULL,
     data TEXT NOT NULL,
     canonical BOOLEAN NOT NULL DEFAULT TRUE,
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_stock_usd_reference_events_pkey PRIMARY KEY (
       chain, protocol, market_key, block_hash, log_index
     ),
     CONSTRAINT rh_stock_usd_reference_events_values_check CHECK (
       chain='robinhood' AND protocol IN ('uniswap-v2','uniswap-v3','uniswap-v4')
       AND block_number>=0 AND transaction_index>=0 AND log_index>=0
       AND stock_address ~ '^0x[0-9a-f]{40}$'
       AND address ~ '^0x[0-9a-f]{40}$'
       AND jsonb_typeof(topics)='array' AND jsonb_array_length(topics)>0
     )
   )`,
  `ALTER TABLE ${TABLE}
     ADD COLUMN IF NOT EXISTS canonical BOOLEAN NOT NULL DEFAULT TRUE`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
     ON ${TABLE}(
       chain, stock_address, market_key, block_number DESC,
       transaction_index DESC, log_index DESC
     ) WHERE canonical=TRUE`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const index of LEGACY_INDEX_NAMES) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);
    }
    for (const statement of STATEMENTS.slice(0, -1)) await database.query(statement);
    const current = await database.query(
      'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
      [INDEX_NAME]
    );
    if (current.rows[0] && (!current.rows[0].indisvalid || !current.rows[0].indisready)) {
      await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);
    }
    await database.query(STATEMENTS.at(-1));
    const ready = await database.query(
      'SELECT indisvalid, indisready FROM pg_index WHERE indexrelid=to_regclass($1)',
      [INDEX_NAME]
    );
    if (!ready.rows[0]?.indisvalid || !ready.rows[0]?.indisready) {
      throw new Error(`Stage 222 index is not ready: ${INDEX_NAME}`);
    }
    console.log('Stage 222 compact Robinhood stock/USD reference journal created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 222:', error.message);
  process.exitCode = 1;
});

module.exports = { INDEX_NAME, LEGACY_INDEX_NAMES, STATEMENTS, TABLE, init };
