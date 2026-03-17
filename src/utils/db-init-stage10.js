const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_price_change_1h NUMERIC(20, 2)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_price_change_6h NUMERIC(20, 2)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_price_change_24h NUMERIC(20, 2)`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_token_created_at_ms BIGINT`,
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 10 dashboard monitor fields created successfully');
    console.log('   - token_catalog pchange and token-created fields');
  } catch (err) {
    console.error('Failed to create stage 10 dashboard monitor fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
