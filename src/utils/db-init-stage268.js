'use strict';
const db = require('../models/db');
const INDEX_NAME = 'idx_token_catalog_rh_creation_address';
const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
    ON token_catalog(last_token_created_at_ms, address)
    WHERE chain = 'robinhood' AND last_token_created_at_ms > 0`,
]);

async function init(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    // CONCURRENTLY must run outside a transaction, on a dedicated connection.
    await client.query("SET lock_timeout = '1s'");
    await client.query("SET statement_timeout = '120s'");
    for (const sql of STATEMENTS) await client.query(sql);
    const result = await client.query(`SELECT index.indisvalid, index.indisready
      FROM pg_index index WHERE index.indexrelid = to_regclass($1)`, [INDEX_NAME]);
    if (result.rows[0]?.indisvalid !== true || result.rows[0]?.indisready !== true) {
      throw new Error(`${INDEX_NAME} is invalid; inspect it before retrying`);
    }
  } finally {
    await client.query('RESET lock_timeout').catch(() => {});
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
    if (options.closePool !== false) await database.pool.end();
  }
}
if (require.main === module) init().catch((error) => {
  console.error('Stage 268 Radar creation index failed:', error.message);
  process.exitCode = 1;
});
module.exports = { INDEX_NAME, STATEMENTS, init };
