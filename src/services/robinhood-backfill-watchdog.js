const db = require('../models/db');

function boundedInteger(value, label, fallback, minimum, maximum) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function createRobinhoodBackfillWatchdog(options = {}) {
  const database = options.database || db;
  const logger = options.logger || console;
  const now = options.now || Date.now;

  async function runOnce(input = {}) {
    const staleQueryThresholdMs = boundedInteger(
      input.staleQueryThresholdMs,
      'staleQueryThresholdMs',
      20_000,
      5000,
      300_000
    );
    const result = await database.query(
      `WITH stale_finalizers AS MATERIALIZED (
         SELECT pid,
                FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::bigint
                  AS age_ms
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND usename = current_user
           AND pid <> pg_backend_pid()
           AND backend_type = 'client backend'
           AND state = 'active'
           AND query_start < clock_timestamp() - ($1::integer * INTERVAL '1 millisecond')
           AND query ~ '^[[:space:]]*WITH candidate_ranges AS MATERIALIZED'
           AND query LIKE '%COUNT(staging.transaction_hash)%'
           AND query LIKE '%robinhood_market_log_staging%'
       )
       SELECT pid, age_ms, pg_cancel_backend(pid) AS cancelled
       FROM stale_finalizers
       ORDER BY age_ms DESC`,
      [staleQueryThresholdMs]
    );
    const staleQueries = result.rows.map((row) => ({
      pid: Number(row.pid),
      ageMs: Number(row.age_ms),
      cancelled: row.cancelled === true,
    }));
    const cancelledPids = staleQueries
      .filter((entry) => entry.cancelled)
      .map((entry) => entry.pid);
    if (staleQueries.length > 0) {
      logger.warn?.(
        `[RobinhoodBackfillWatchdog] stale finalizer queries=${staleQueries.length}`
        + ` cancelled=${cancelledPids.length}`
        + ` pids=${cancelledPids.join(',') || 'none'}`
      );
    }
    return {
      status: cancelledPids.length > 0 ? 'cancelled' : 'healthy',
      checkedAt: new Date(now()).toISOString(),
      staleQueryThresholdMs,
      staleQueries,
      cancelledPids,
    };
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  createRobinhoodBackfillWatchdog,
};
