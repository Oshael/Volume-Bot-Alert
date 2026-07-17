/**
 * Stage 61 - Replace the legacy OHLC sparkline covering index with a
 * chain-aware equivalent. This changes query support only; Robinhood reads
 * and writes remain disabled in the legacy OHLC model.
 * Run with: node src/utils/db-init-stage61.js
 */
const db = require('../models/db');

const MIGRATION_LOCK_ID = 610001;
const BUILD_CHAIN_COVER_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_token_market_buckets_1m_chain_sparkline_cover
  ON token_market_buckets_1m(chain, token_address, bucket_ts DESC)
  INCLUDE (pair_address, close_mcap)
  WHERE close_mcap IS NOT NULL`;
const DROP_LEGACY_COVER_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_1m_sparkline_cover`;

const STATEMENTS = [
  BUILD_CHAIN_COVER_STATEMENT,
  DROP_LEGACY_COVER_STATEMENT,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  let lockAcquired = false;
  try {
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await db.query(BUILD_CHAIN_COVER_STATEMENT);
    await db.query(DROP_LEGACY_COVER_STATEMENT);
    console.log('Stage 61 chain-aware OHLC sparkline index applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 61 OHLC sparkline index:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (lockAcquired) {
      try { await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]); } catch (_) {}
    }
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) init().catch(() => {});

module.exports = { STATEMENTS, init };
