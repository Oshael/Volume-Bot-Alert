/**
 * Stage 46 - Admin token review alert queue.
 * Run with: node src/utils/db-init-stage46.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admin_token_review_alerts (
     id SERIAL PRIMARY KEY,
     chain VARCHAR(16) NOT NULL DEFAULT 'solana',
     token_address VARCHAR(64) NOT NULL,
     status VARCHAR(24) NOT NULL DEFAULT 'open',
     priority VARCHAR(24) NOT NULL DEFAULT 'normal',
     alert_kind VARCHAR(64) NOT NULL,
     pipeline VARCHAR(64) NOT NULL,
     label VARCHAR(160),
     reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
     assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
     social_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     market_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     risk_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     meteora_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     resolved_at TIMESTAMPTZ,
     resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     resolution VARCHAR(32),
     notes TEXT
   )`,
  `ALTER TABLE admin_token_review_alerts
     ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_review_alerts_open_chain_token_kind
     ON admin_token_review_alerts(chain, token_address, alert_kind)
     WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS idx_admin_token_review_alerts_status_priority
     ON admin_token_review_alerts(status, priority, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_token_review_alerts_chain_token_created
     ON admin_token_review_alerts(chain, token_address, created_at DESC, id DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 46 admin token review alert queue created successfully');
    console.log('   - admin_token_review_alerts');
  } catch (err) {
    console.error('Failed to create stage 46 admin token review alert queue:', err.message);
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
