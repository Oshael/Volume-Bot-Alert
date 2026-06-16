/**
 * Etapa 43 - GMGN claim signal baseline flag.
 * Rodar com: node src/utils/db-init-stage43.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE gmgn_claim_alert_events
     ADD COLUMN IF NOT EXISTS is_baseline BOOLEAN NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS idx_gmgn_claim_alert_events_visible_rule_triggered
     ON gmgn_claim_alert_events(rule_key, triggered_at DESC, id DESC)
     WHERE is_baseline = false`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 43 GMGN claim signal baseline flag applied successfully');
    console.log('   - gmgn_claim_alert_events.is_baseline');
  } catch (err) {
    console.error('Failed to apply stage 43 GMGN claim signal baseline flag:', err.message);
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
