'use strict';

/** Stage 257 - durable source revisions for Robinhood wallet ranking invalidation. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_wallet_ranking_revisions (
     source VARCHAR(16) NOT NULL,
     version BIGINT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_wallet_ranking_revisions_pkey PRIMARY KEY (source),
     CONSTRAINT rh_wallet_ranking_revisions_source_check CHECK (
       source IN ('positions', 'transfers', 'swaps', 'prices', 'reorg')
     ),
     CONSTRAINT rh_wallet_ranking_revisions_version_check CHECK (version > 0)
   )`,
]);

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 257:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
