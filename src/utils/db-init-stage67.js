/**
 * Stage 67 - Exact Robinhood liquidity evidence on market observations.
 * V2 stores a spot USD estimate; v3/v4 store only the raw liquidity scalar
 * and an explicit status requiring tick/position distribution.
 * Run with: node src/utils/db-init-stage67.js
 */
const db = require('../models/db');

const STATEMENTS = [
  `ALTER TABLE robinhood_market_observations
     ADD COLUMN IF NOT EXISTS liquidity_usd NUMERIC,
     ADD COLUMN IF NOT EXISTS liquidity_raw NUMERIC(78, 0),
     ADD COLUMN IF NOT EXISTS liquidity_status VARCHAR(64),
     ADD COLUMN IF NOT EXISTS liquidity_confidence VARCHAR(16),
     ADD COLUMN IF NOT EXISTS liquidity_warning VARCHAR(64)`,
  `DO $migration$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'robinhood_market_observations'::regclass
         AND conname = 'robinhood_market_observations_liquidity_values_check'
     ) THEN
       ALTER TABLE robinhood_market_observations
         ADD CONSTRAINT robinhood_market_observations_liquidity_values_check CHECK (
           (liquidity_usd IS NULL OR liquidity_usd >= 0)
           AND (liquidity_raw IS NULL OR liquidity_raw >= 0)
         );
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'robinhood_market_observations'::regclass
         AND conname = 'robinhood_market_observations_liquidity_protocol_check'
     ) THEN
       ALTER TABLE robinhood_market_observations
         ADD CONSTRAINT robinhood_market_observations_liquidity_protocol_check CHECK (
           (protocol = 'uniswap-v2' AND liquidity_raw IS NULL)
           OR (protocol IN ('uniswap-v3', 'uniswap-v4') AND liquidity_usd IS NULL)
         );
     END IF;
   END
   $migration$`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 67 Robinhood observation liquidity evidence added successfully');
  } catch (error) {
    console.error('Failed to add stage 67 Robinhood observation liquidity:', error.message);
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
