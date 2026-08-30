/** Stage 182 - canonical frozen frontiers for the signed-origin bootstrap. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_wallet_signed_origin_cursors
     ADD COLUMN IF NOT EXISTS origin_block_hash VARCHAR(66),
     ADD COLUMN IF NOT EXISTS safe_head_hash VARCHAR(66)`,
  `ALTER TABLE robinhood_wallet_signed_origin_cursors
     ALTER COLUMN safe_head SET NOT NULL,
     ALTER COLUMN origin_block_hash SET NOT NULL,
     ALTER COLUMN safe_head_hash SET NOT NULL`,
  `ALTER TABLE robinhood_wallet_signed_origin_cursors
     DROP CONSTRAINT IF EXISTS rh_wallet_signed_origin_cursors_frozen_check,
     ADD CONSTRAINT rh_wallet_signed_origin_cursors_frozen_check CHECK (
       origin_block_hash ~ '^0x[0-9a-f]{64}$'
       AND safe_head_hash ~ '^0x[0-9a-f]{64}$'
       AND safe_head IS NOT NULL AND safe_head >= origin_block
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 182 Robinhood signed-origin frozen frontiers created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 182:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
