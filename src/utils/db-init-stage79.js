/**
 * Stage 79 - Robinhood historical supply provenance.
 * Records how total supply was established for each accepted exact observation.
 * Run with: node src/utils/db-init-stage79.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE robinhood_market_observations
     ADD COLUMN IF NOT EXISTS token_supply_status VARCHAR(32),
     ADD COLUMN IF NOT EXISTS token_supply_anchor_block_number BIGINT`,
  `ALTER TABLE robinhood_market_observations
     DROP CONSTRAINT IF EXISTS robinhood_market_observations_supply_provenance_check`,
  `ALTER TABLE robinhood_market_observations
     ADD CONSTRAINT robinhood_market_observations_supply_provenance_check CHECK (
       status <> 'accepted' OR (
         token_supply_status IN (
           'exact_block_call',
           'reconstructed_mint_burn',
           'unchanged_between_anchors'
         )
         AND token_supply_anchor_block_number IS NOT NULL
         AND token_supply_anchor_block_number >= 0
         AND token_supply_anchor_block_number <= block_number
         AND (
           token_supply_status <> 'exact_block_call'
           OR token_supply_anchor_block_number = block_number
         )
       )
     ) NOT VALID`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 79 Robinhood supply provenance created successfully');
  } catch (error) {
    console.error('Failed to create stage 79 Robinhood supply provenance:', error.message);
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
