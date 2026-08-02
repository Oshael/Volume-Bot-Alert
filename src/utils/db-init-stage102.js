/** Stage 102 - Allow point-in-time Uniswap V4 tick-range TVL. */
const db = require('../models/db');
const { TABLES, liquidityCheck } = require('./db-init-stage98');

const STATEMENTS = Object.freeze(TABLES.map(({ table, constraint, prefix }) => (
  `ALTER TABLE ${table}
     DROP CONSTRAINT IF EXISTS ${constraint},
     ADD CONSTRAINT ${constraint} CHECK ${liquidityCheck(prefix, { v4TickTvl: true })}`
)));

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 102 Robinhood V4 tick-range TVL enabled successfully');
  } catch (error) {
    console.error('Failed to enable Stage 102 Robinhood V4 TVL:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init };
