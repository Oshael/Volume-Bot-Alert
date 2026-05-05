/**
 * Etapa 36 - GMGN panel state and Dex handoff.
 * Rodar com: node src/utils/db-init-stage36.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_gmgn_panel_state (
     token_address VARCHAR(64) PRIMARY KEY,
     first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_interval VARCHAR(8),
     last_rank INTEGER,
     last_mcap NUMERIC(20, 2),
     last_vol_1m NUMERIC(20, 2),
     last_vol_5m NUMERIC(20, 2),
     last_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     dex_handoff_at TIMESTAMPTZ,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CHECK (status IN ('active', 'stale'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_gmgn_panel_state_status_seen
     ON token_gmgn_panel_state(status, last_seen_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_token_gmgn_panel_state_handoff
     ON token_gmgn_panel_state(dex_handoff_at DESC NULLS LAST)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 36 GMGN panel state table created successfully');
    console.log('   - token_gmgn_panel_state');
  } catch (err) {
    console.error('Failed to create stage 36 GMGN panel state table:', err.message);
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
