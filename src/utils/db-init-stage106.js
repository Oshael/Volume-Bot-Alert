/**
 * Stage 106 - Valuation-market provenance for token-level Robinhood aggregates.
 *
 * Existing aggregate rows remain valid with NULL provenance until the historical
 * rebuild rewrites them. New aggregate writers will populate all three columns
 * together after the valuation-market selection behavior is deployed.
 * Run with: node src/utils/db-init-stage106.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_market_buckets_agg
     ADD COLUMN IF NOT EXISTS valuation_protocol VARCHAR(16),
     ADD COLUMN IF NOT EXISTS valuation_market_key VARCHAR(160),
     ADD COLUMN IF NOT EXISTS valuation_volume_24h_usd NUMERIC`,
  `ALTER TABLE robinhood_market_buckets_agg
     DROP CONSTRAINT IF EXISTS robinhood_market_buckets_agg_valuation_market_check`,
  `ALTER TABLE robinhood_market_buckets_agg
     ADD CONSTRAINT robinhood_market_buckets_agg_valuation_market_check CHECK (
       (
         valuation_protocol IS NULL
         AND valuation_market_key IS NULL
         AND valuation_volume_24h_usd IS NULL
       )
       OR (
         valuation_protocol IS NOT NULL
         AND valuation_protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
         AND valuation_market_key IS NOT NULL
         AND valuation_volume_24h_usd IS NOT NULL
         AND valuation_volume_24h_usd >= 0
       )
     ) NOT VALID`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 106 Robinhood aggregate valuation provenance added successfully');
  } catch (error) {
    console.error('Failed to add Stage 106 Robinhood aggregate valuation provenance:', error.message);
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
