/**
 * Etapa 42 - GMGN claim signal alert persistence.
 * Rodar com: node src/utils/db-init-stage42.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS gmgn_claim_alert_state (
     rule_key VARCHAR(64) NOT NULL,
     token_address VARCHAR(64) NOT NULL,
     alert_count INTEGER NOT NULL DEFAULT 0,
     last_claim_id VARCHAR(255),
     last_claimed_at TIMESTAMPTZ,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (rule_key, token_address)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gmgn_claim_alert_state_updated
     ON gmgn_claim_alert_state(rule_key, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS gmgn_claim_alert_events (
     id BIGSERIAL PRIMARY KEY,
     rule_key VARCHAR(64) NOT NULL,
     token_address VARCHAR(64) NOT NULL,
     signal_type INTEGER NOT NULL,
     source VARCHAR(32) NOT NULL DEFAULT 'gmgn',
     claim_sequence INTEGER NOT NULL,
     claim_id VARCHAR(255) NOT NULL,
     total_fee_usd NUMERIC(20, 4),
     claimed_at TIMESTAMPTZ NOT NULL,
     payload JSONB NOT NULL DEFAULT '{}'::jsonb,
     triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (rule_key, claim_id),
     UNIQUE (rule_key, token_address, claim_sequence)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gmgn_claim_alert_events_rule_triggered
     ON gmgn_claim_alert_events(rule_key, triggered_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gmgn_claim_alert_events_token_triggered
     ON gmgn_claim_alert_events(token_address, triggered_at DESC, id DESC)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 42 GMGN claim signal alert persistence created successfully');
    console.log('   - gmgn_claim_alert_state');
    console.log('   - gmgn_claim_alert_events');
  } catch (err) {
    console.error('Failed to create stage 42 GMGN claim signal alert persistence:', err.message);
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
