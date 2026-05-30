/**
 * Etapa 41 - Token catalog community URL.
 * Rodar com: node src/utils/db-init-stage41.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_community_url TEXT`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 41 token catalog community URL field created successfully');
    console.log('   - token_catalog.last_community_url');
  } catch (err) {
    console.error('Failed to create stage 41 token catalog community URL field:', err.message);
    process.exit(1);
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) {
  init();
}

module.exports = { init, STATEMENTS };
