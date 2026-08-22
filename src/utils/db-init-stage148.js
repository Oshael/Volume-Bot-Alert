/** Stage 148 - Durable cursor for independent Robinhood liquidity events. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_pool_liquidity_event_cursors (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     coverage_start_block BIGINT NOT NULL,
     next_block BIGINT NOT NULL,
     safe_head BIGINT,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     checkpoint_timestamp TIMESTAMPTZ,
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_pool_liquidity_event_cursors_pkey PRIMARY KEY (chain),
     CONSTRAINT robinhood_pool_liquidity_event_cursors_chain_check
       CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_pool_liquidity_event_cursors_range_check CHECK (
       coverage_start_block >= 0 AND next_block >= coverage_start_block
       AND (safe_head IS NULL OR safe_head >= 0)
     ),
     CONSTRAINT robinhood_pool_liquidity_event_cursors_checkpoint_check CHECK (
       (checkpoint_block IS NULL AND checkpoint_hash IS NULL
         AND checkpoint_timestamp IS NULL)
       OR (checkpoint_block = next_block - 1
         AND checkpoint_hash ~ '^0x[0-9a-f]{64}$')
     )
   )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 148 Robinhood pool liquidity event cursor created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 148:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
