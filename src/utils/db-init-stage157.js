/** Stage 157 - typed lazy evidence for Robinhood launch anchors. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_token_launch_anchors
     ADD COLUMN IF NOT EXISTS launch_block_time TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS anchor_wallet_address VARCHAR(42),
     ADD COLUMN IF NOT EXISTS anchor_transaction_hash VARCHAR(66),
     ADD COLUMN IF NOT EXISTS anchor_transaction_index INTEGER,
     ADD COLUMN IF NOT EXISTS anchor_action_index BIGINT,
     ADD COLUMN IF NOT EXISTS anchor_block_hash VARCHAR(66),
     ADD COLUMN IF NOT EXISTS anchor_side VARCHAR(4),
     ADD COLUMN IF NOT EXISTS anchor_volume_usd NUMERIC`,
  `ALTER TABLE robinhood_token_launch_anchors
     DROP CONSTRAINT IF EXISTS rh_token_launch_anchors_detail_check,
     ADD CONSTRAINT rh_token_launch_anchors_detail_check CHECK (
       (
         anchor_wallet_address IS NULL
         AND anchor_transaction_hash IS NULL
         AND anchor_transaction_index IS NULL
         AND anchor_action_index IS NULL
         AND anchor_block_hash IS NULL
         AND anchor_side IS NULL
         AND anchor_volume_usd IS NULL
       ) OR (
         launch_block_time IS NOT NULL
         AND anchor_wallet_address IS NOT NULL
         AND anchor_wallet_address ~ '^0x[0-9a-f]{40}$'
         AND anchor_transaction_hash IS NOT NULL
         AND anchor_transaction_hash ~ '^0x[0-9a-f]{64}$'
         AND anchor_transaction_index IS NOT NULL
         AND anchor_transaction_index >= 0
         AND anchor_action_index IS NOT NULL
         AND anchor_action_index >= 0
         AND anchor_block_hash IS NOT NULL
         AND anchor_block_hash ~ '^0x[0-9a-f]{64}$'
         AND anchor_side IS NOT NULL
         AND anchor_side IN ('buy', 'sell')
         AND (anchor_volume_usd IS NULL OR anchor_volume_usd >= 0)
       )
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 157 Robinhood typed launch-anchor evidence created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 157:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
