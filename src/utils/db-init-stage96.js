/**
 * Stage 96 - Robinhood live supply provenance (latest_call).
 * Extends the stage 79 supply-provenance CHECK so accepted observations may also
 * record supply established from a current ("latest") read, used by the live
 * event-driven enrichment path against a pruned node. Backfill keeps emitting the
 * exact/reconstructed statuses. Anchor stays bound to the swap block (<= block_number).
 * Run with: node src/utils/db-init-stage96.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE robinhood_market_observations
     DROP CONSTRAINT IF EXISTS robinhood_market_observations_supply_provenance_check`,
  `ALTER TABLE robinhood_market_observations
     ADD CONSTRAINT robinhood_market_observations_supply_provenance_check CHECK (
       status <> 'accepted' OR (
         token_supply_status IN (
           'exact_block_call',
           'reconstructed_mint_burn',
           'unchanged_between_anchors',
           'latest_call'
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
    console.log('Stage 96 Robinhood live supply provenance created successfully');
  } catch (error) {
    console.error('Failed to create stage 96 Robinhood live supply provenance:', error.message);
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
