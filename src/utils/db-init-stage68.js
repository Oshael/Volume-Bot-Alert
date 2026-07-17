/**
 * Stage 68 - Latest exact liquidity snapshot on Robinhood market buckets.
 * Existing buckets remain nullable and therefore fail closed until refreshed.
 * Run with: node src/utils/db-init-stage68.js
 */
const db = require('../models/db');

const BUCKET_TABLES = Object.freeze([
  'robinhood_market_buckets_1m',
  'robinhood_market_buckets_1h',
]);

function addColumns(table) {
  return `ALTER TABLE ${table}
    ADD COLUMN IF NOT EXISTS close_liquidity_usd NUMERIC,
    ADD COLUMN IF NOT EXISTS close_liquidity_raw NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS close_liquidity_status VARCHAR(64),
    ADD COLUMN IF NOT EXISTS close_liquidity_confidence VARCHAR(16),
    ADD COLUMN IF NOT EXISTS close_liquidity_warning VARCHAR(64)`;
}

function addConstraint(table) {
  return `DO $migration$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = '${table}'::regclass
        AND conname = '${table}_liquidity_check'
    ) THEN
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_liquidity_check CHECK (
          (
            close_liquidity_usd IS NULL
            AND close_liquidity_raw IS NULL
            AND close_liquidity_status IS NULL
            AND close_liquidity_confidence IS NULL
          )
          OR (
            protocol = 'uniswap-v2'
            AND close_liquidity_raw IS NULL
            AND (
              (
                close_liquidity_status = 'spot_estimate_from_double_quote_reserve'
                AND close_liquidity_usd >= 0
                AND close_liquidity_confidence = 'medium'
              )
              OR (
                close_liquidity_status = 'missing_v2_reserve_or_quote'
                AND close_liquidity_usd IS NULL
                AND close_liquidity_confidence = 'none'
              )
            )
          )
          OR (
            protocol IN ('uniswap-v3', 'uniswap-v4')
            AND close_liquidity_usd IS NULL
            AND close_liquidity_raw >= 0
            AND close_liquidity_status = 'requires_tick_liquidity_distribution'
            AND close_liquidity_confidence = 'none'
          )
        );
    END IF;
  END
  $migration$`;
}

const STATEMENTS = BUCKET_TABLES.flatMap((table) => [
  addColumns(table),
  addConstraint(table),
]);

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 68 Robinhood bucket liquidity snapshots added successfully');
  } catch (error) {
    console.error('Failed to add stage 68 Robinhood bucket liquidity snapshots:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { BUCKET_TABLES, STATEMENTS, init };
