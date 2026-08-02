/** Stage 100 - Resumable one-time Robinhood V4 liquidity replay cursor. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_replay_state (
     chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
     start_block BIGINT NOT NULL,
     next_block BIGINT NOT NULL,
     target_block BIGINT NOT NULL,
     checkpoint_block BIGINT,
     checkpoint_hash VARCHAR(66),
     status VARCHAR(16) NOT NULL DEFAULT 'running',
     version BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT robinhood_v4_liquidity_replay_state_pkey PRIMARY KEY (chain),
     CONSTRAINT robinhood_v4_liquidity_replay_state_chain_check CHECK (chain = 'robinhood'),
     CONSTRAINT robinhood_v4_liquidity_replay_state_status_check
       CHECK (status IN ('running', 'completed')),
     CONSTRAINT robinhood_v4_liquidity_replay_state_bounds_check
       CHECK (start_block >= 0 AND next_block >= start_block AND target_block >= start_block),
     CONSTRAINT robinhood_v4_liquidity_replay_state_checkpoint_check CHECK (
       (checkpoint_block IS NULL) = (checkpoint_hash IS NULL)
       AND (checkpoint_block IS NULL OR checkpoint_block < next_block)
     ),
     CONSTRAINT robinhood_v4_liquidity_replay_state_completion_check
       CHECK ((status = 'completed') = (next_block > target_block)),
     CONSTRAINT robinhood_v4_liquidity_replay_state_version_check CHECK (version >= 0)
   )`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 100 Robinhood V4 liquidity replay state created successfully');
  } catch (error) {
    console.error('Failed to create Stage 100 Robinhood V4 replay state:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});
module.exports = { STATEMENTS, init };
