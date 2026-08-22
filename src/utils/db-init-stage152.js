/** Stage 152 - durable LIVE cursor for canonical Robinhood first-buy evidence. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_first_buy_live_cursors (
     chain VARCHAR(16) PRIMARY KEY DEFAULT 'robinhood',
     seed_run_id BIGINT NOT NULL
       REFERENCES robinhood_first_buy_backfill_runs(id) ON DELETE RESTRICT,
     next_time TIMESTAMPTZ NOT NULL,
     source_through TIMESTAMPTZ NOT NULL,
     source_next_block BIGINT,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT rh_first_buy_live_cursors_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT rh_first_buy_live_cursors_progress_check CHECK (
       next_time <= source_through AND version >= 0
       AND (source_next_block IS NULL OR source_next_block >= 0)
     )
   )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 152 Robinhood first-buy LIVE cursor created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 152:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
