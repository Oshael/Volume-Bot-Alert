'use strict';

/** Stage 265 - holder coverage candidates, independent of creator work. */
const db = require('../models/db');
const TABLE_NAME = 'robinhood_holder_coverage_pending';
const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    chain VARCHAR(16) NOT NULL DEFAULT 'robinhood' CHECK (chain='robinhood'),
    token_address VARCHAR(42) NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
    from_block BIGINT NOT NULL CHECK (from_block >= 0),
    block_hash VARCHAR(66) NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    transaction_hash VARCHAR(66) NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    generation BIGINT NOT NULL CHECK (generation >= 0),
    status VARCHAR(16) NOT NULL,
    reason VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT rh_holder_coverage_pending_pkey PRIMARY KEY (chain, token_address),
    CONSTRAINT rh_holder_coverage_pending_status_check CHECK (
      (status='pending' AND reason='coverage_and_handoff_unconfirmed') OR
      (status='excluded' AND reason IN ('incompatible_transfer', 'canonical_contract',
        'robinhood_tokenized_asset', 'admin_blocked'))
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rh_holder_coverage_pending_floor
    ON ${TABLE_NAME} (chain, from_block) WHERE status='pending'`,
]);

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='1s'");
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end();
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Stage 265 holder coverage protection failed:', error.message);
  process.exitCode = 1;
});
module.exports = { TABLE_NAME, STATEMENTS, init };
