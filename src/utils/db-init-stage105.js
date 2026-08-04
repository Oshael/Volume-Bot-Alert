/**
 * Stage 105 - Allow NULL FDV in the Robinhood market bucket tables.
 * A token whose reported totalSupply is uncapped (uint256-max sentinel) has no
 * meaningful FDV, so buildMarketObservation now emits fdvUsd = null for it (the
 * valid price/volume are kept). The bucket tables were created with the fdv
 * columns NOT NULL, which would reject those rows and halt the commit. This
 * migration drops NOT NULL on the four fdv columns of every bucket table; the
 * existing >= 0 / high >= low CHECKs stay valid because a NULL never violates a
 * CHECK, and a bucket is keyed per token so its fdv nullness is uniform.
 * Idempotent (DROP NOT NULL on an already-nullable column is a no-op).
 * Run with: node src/utils/db-init-stage105.js
 */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_market_buckets_1m
     ALTER COLUMN open_fdv_usd DROP NOT NULL,
     ALTER COLUMN high_fdv_usd DROP NOT NULL,
     ALTER COLUMN low_fdv_usd DROP NOT NULL,
     ALTER COLUMN close_fdv_usd DROP NOT NULL`,
  `ALTER TABLE robinhood_market_buckets_1h
     ALTER COLUMN open_fdv_usd DROP NOT NULL,
     ALTER COLUMN high_fdv_usd DROP NOT NULL,
     ALTER COLUMN low_fdv_usd DROP NOT NULL,
     ALTER COLUMN close_fdv_usd DROP NOT NULL`,
  `ALTER TABLE robinhood_market_buckets_agg
     ALTER COLUMN open_fdv_usd DROP NOT NULL,
     ALTER COLUMN high_fdv_usd DROP NOT NULL,
     ALTER COLUMN low_fdv_usd DROP NOT NULL,
     ALTER COLUMN close_fdv_usd DROP NOT NULL`,
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 105 Robinhood bucket FDV columns are now nullable');
  } catch (error) {
    console.error('Failed to apply Stage 105 nullable bucket FDV:', error.message);
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
