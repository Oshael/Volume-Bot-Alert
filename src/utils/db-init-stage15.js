/**
 * Etapa 15 - Access entitlement foundation.
 * Rodar com: node src/utils/db-init-stage15.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status VARCHAR(16) NOT NULL DEFAULT 'inactive'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_source VARCHAR(16) NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE users ALTER COLUMN access_status SET DEFAULT 'inactive'`,
  `ALTER TABLE users ALTER COLUMN access_granted_at SET DEFAULT NOW()`,
  `ALTER TABLE users ALTER COLUMN access_source SET DEFAULT 'manual'`,
  `ALTER TABLE users ALTER COLUMN access_updated_at SET DEFAULT NOW()`,
  `CREATE INDEX IF NOT EXISTS idx_users_access_status ON users(access_status)`,
  `CREATE INDEX IF NOT EXISTS idx_users_access_expires_at ON users(access_expires_at)`
];

async function init() {
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 15 access entitlement fields created successfully');
    console.log('   - users.access_status');
    console.log('   - users.access_granted_at');
    console.log('   - users.access_expires_at');
    console.log('   - users.access_source');
    console.log('   - users.access_updated_at');
  } catch (err) {
    console.error('Failed to create stage 15 fields:', err.message);
    process.exit(1);
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

init();
