const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS eligibility_state VARCHAR(32) NOT NULL DEFAULT 'unknown'`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS eligible_for_monitoring BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS suppressed_reason TEXT`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_eligible_at TIMESTAMPTZ`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS next_evaluation_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS evaluation_error_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_evaluation_error TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_next_evaluation ON token_catalog(next_evaluation_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_catalog_eligible_for_monitoring ON token_catalog(eligible_for_monitoring)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 6 catalog fields created successfully');
    console.log('   - token_catalog operational fields');
  } catch (err) {
    console.error('Failed to create stage 6 catalog fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
