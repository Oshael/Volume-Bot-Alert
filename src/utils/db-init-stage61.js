/** Stage 61 - Retire unused OHLC sparkline covering indexes. */
const db = require('../models/db');

const MIGRATION_LOCK_ID = 610001;
const DROP_LEGACY_COVER_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_1m_sparkline_cover`;
const DROP_CHAIN_COVER_STATEMENT =
  `DROP INDEX CONCURRENTLY IF EXISTS idx_token_market_buckets_1m_chain_sparkline_cover`;

const STATEMENTS = [
  DROP_LEGACY_COVER_STATEMENT,
  DROP_CHAIN_COVER_STATEMENT,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  let lockAcquired = false;
  try {
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await db.query(DROP_LEGACY_COVER_STATEMENT);
    await db.query(DROP_CHAIN_COVER_STATEMENT);
    console.log('Stage 61 unused OHLC sparkline indexes retired successfully');
  } catch (error) {
    console.error('Failed to retire stage 61 OHLC sparkline indexes:', error.message);
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
