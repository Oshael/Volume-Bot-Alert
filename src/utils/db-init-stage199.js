'use strict';

/** Stage 199 - preserve bundle-funding work that still requires Archive history. */
const db = require('../models/db');
const { ENQUEUE_FUNCTION_STATEMENT } = require('./db-init-stage172');

const STATEMENTS = Object.freeze([ENQUEUE_FUNCTION_STATEMENT]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 199 bundle-funding Archive preservation created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 199:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
