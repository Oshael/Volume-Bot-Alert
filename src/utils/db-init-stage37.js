/**
 * Etapa 37 - Meteora state persisted baseline fields.
 * Rodar com: node src/utils/db-init-stage37.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS last_snapshot_at TIMESTAMPTZ`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_1h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_4h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_6h NUMERIC(20, 2)`,
  `ALTER TABLE token_meteora_state
     ADD COLUMN IF NOT EXISTS baseline_tvl_24h NUMERIC(20, 2)`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) {
      await db.query(statement);
    }
    console.log('Stage 37 Meteora state baseline fields created successfully');
    console.log('   - token_meteora_state.last_snapshot_at');
    console.log('   - token_meteora_state.baseline_tvl_1h');
    console.log('   - token_meteora_state.baseline_tvl_4h');
    console.log('   - token_meteora_state.baseline_tvl_6h');
    console.log('   - token_meteora_state.baseline_tvl_24h');
  } catch (err) {
    console.error('Failed to create stage 37 Meteora state baseline fields:', err.message);
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
