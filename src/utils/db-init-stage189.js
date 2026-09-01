'use strict';

/** Stage 189 - keep the holder hot queue scoped to tracked token states. */
const db = require('../models/db');
const { HOT_QUEUE_REPAIR_STATEMENTS: STATEMENTS } = require('./db-init-stage180');

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 189 Robinhood holder hot queue scope repaired successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 189:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
