/**
 * Stage 50 - Distributed worker leases.
 * Run with: node src/utils/db-init-stage50.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS worker_leases (
     lease_key VARCHAR(128) PRIMARY KEY,
     owner_id VARCHAR(128) NOT NULL,
     owner_pid INTEGER,
     owner_hostname VARCHAR(128),
     acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     lease_until TIMESTAMPTZ NOT NULL,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS idx_worker_leases_lease_until
     ON worker_leases(lease_until)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_leases_owner
     ON worker_leases(owner_id)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 50 distributed worker leases created successfully');
    console.log('   - worker_leases');
  } catch (err) {
    console.error('Failed to create stage 50 distributed worker leases:', err.message);
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
