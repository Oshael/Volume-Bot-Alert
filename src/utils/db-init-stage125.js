'use strict';

// Stage 125: make the operator-facing X session label the durable identity used
// by re-seed. The unique index is intentionally added in its own stage: if an
// older database already contains duplicate labels, the migration fails loudly
// instead of choosing credentials to discard.

const db = require('../models/db');

const STATEMENTS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_x_session_label_unique
     ON x_session(label)`,
];

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 125 X session label uniqueness created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  init().catch((error) => {
    console.error('Failed to create Stage 125:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, init };
