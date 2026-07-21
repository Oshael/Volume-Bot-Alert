const db = require('../models/db');

const CONFIRM_FLAG = '--confirm-reset-robinhood-market';
const DERIVED_DATA_CONFIRM_FLAG = '--confirm-delete-robinhood-derived-market-data';
const LOCK_ID = 4663002;
const INSPECT_SQL = `SELECT
  EXISTS (
    SELECT 1 FROM worker_leases
    WHERE lease_key = 'robinhood-ingestion-worker' AND lease_until > NOW()
  ) AS live_worker,
  (SELECT next_block::text FROM robinhood_ingestion_cursors
    WHERE chain = 'robinhood' AND stream = 'market') AS market_next_block,
  COALESCE((SELECT MIN(discovery_block) FROM robinhood_pool_registry
    WHERE chain = 'robinhood'), 0)::text AS replay_start_block,
  (SELECT COUNT(*)::int FROM robinhood_pool_registry
    WHERE chain = 'robinhood') AS pools,
  (SELECT COUNT(*)::text FROM robinhood_processed_logs
    WHERE chain = 'robinhood' AND stream = 'market') AS market_log_rows,
  (SELECT COUNT(*)::text FROM robinhood_market_observations
    WHERE chain = 'robinhood') AS observation_rows,
  (SELECT COUNT(*)::text FROM robinhood_market_observations
    WHERE chain = 'robinhood' AND status = 'accepted') AS accepted_observation_rows,
  (SELECT COUNT(*)::text FROM robinhood_market_buckets_1m
    WHERE chain = 'robinhood') AS minute_bucket_rows,
  (SELECT COUNT(*)::text FROM robinhood_market_buckets_1h
    WHERE chain = 'robinhood') AS hourly_bucket_rows,
  (SELECT COUNT(*)::text FROM robinhood_market_buckets_agg
    WHERE chain = 'robinhood') AS aggregate_bucket_rows`;
const RESET_SQL = `WITH
  deleted_agg AS (DELETE FROM robinhood_market_buckets_agg
    WHERE chain = 'robinhood' RETURNING 1),
  deleted_1h AS (DELETE FROM robinhood_market_buckets_1h
    WHERE chain = 'robinhood' RETURNING 1),
  deleted_1m AS (DELETE FROM robinhood_market_buckets_1m
    WHERE chain = 'robinhood' RETURNING 1),
  deleted_observations AS (DELETE FROM robinhood_market_observations
    WHERE chain = 'robinhood' RETURNING 1),
  deleted_logs AS (DELETE FROM robinhood_processed_logs
    WHERE chain = 'robinhood' AND stream = 'market'
      AND (SELECT COUNT(*) FROM deleted_observations) >= 0
    RETURNING 1),
  deleted_cursor AS (DELETE FROM robinhood_ingestion_cursors
    WHERE chain = 'robinhood' AND stream = 'market' RETURNING 1)
SELECT
  (SELECT COUNT(*)::int FROM deleted_logs) AS deleted_market_logs,
  (SELECT COUNT(*)::int FROM deleted_observations) AS deleted_observations,
  (SELECT COUNT(*)::int FROM deleted_1m) AS deleted_1m_buckets,
  (SELECT COUNT(*)::int FROM deleted_1h) AS deleted_1h_buckets,
  (SELECT COUNT(*)::int FROM deleted_agg) AS deleted_aggregate_buckets,
  (SELECT COUNT(*)::int FROM deleted_cursor) AS deleted_market_cursors`;

function countString(value) {
  return /^\d+$/.test(String(value ?? '')) ? String(value) : '0';
}

function planFromRow(row = {}) {
  const marketLogRows = countString(row.market_log_rows);
  const observationRows = countString(row.observation_rows);
  const acceptedObservationRows = countString(row.accepted_observation_rows);
  const minuteBucketRows = countString(row.minute_bucket_rows);
  const hourlyBucketRows = countString(row.hourly_bucket_rows);
  const aggregateBucketRows = countString(row.aggregate_bucket_rows);
  return {
    liveWorker: row.live_worker === true,
    marketNextBlock: row.market_next_block ?? null,
    replayStartBlock: String(row.replay_start_block || '0'),
    pools: Number(row.pools || 0),
    marketLogRows,
    observationRows,
    acceptedObservationRows,
    minuteBucketRows,
    hourlyBucketRows,
    aggregateBucketRows,
    hasMarketLogs: BigInt(marketLogRows) > 0n,
    hasObservations: BigInt(observationRows) > 0n,
    hasAcceptedObservations: BigInt(acceptedObservationRows) > 0n,
    hasBucketRows: [minuteBucketRows, hourlyBucketRows, aggregateBucketRows]
      .some((value) => BigInt(value) > 0n),
  };
}

async function inspectMarketReplay(database = db) {
  const result = typeof database.queryWithStatementTimeout === 'function'
    ? await database.queryWithStatementTimeout(INSPECT_SQL, [], 10_000)
    : await database.query(INSPECT_SQL);
  return planFromRow(result.rows[0]);
}

function assertReplayIsSafe(plan, options = {}) {
  if (plan.liveWorker) throw new Error('Robinhood ingestion lease is still active');
  if (plan.marketNextBlock == null) throw new Error('Robinhood market cursor is already absent');
  if (plan.pools === 0) throw new Error('Robinhood pool registry is empty');
  if (
    (plan.hasAcceptedObservations || plan.hasBucketRows)
    && options.allowDerivedDataReset !== true
  ) {
    throw new Error(
      `Refusing to reset accepted Robinhood market data without ${DERIVED_DATA_CONFIRM_FLAG}`
    );
  }
}

async function resetMarketReplay(database = db, options = {}) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(
      `SELECT lease_key FROM worker_leases
       WHERE lease_key = 'robinhood-ingestion-worker' FOR UPDATE`
    );
    const plan = await inspectMarketReplay(client);
    assertReplayIsSafe(plan, options);
    const result = await client.query(RESET_SQL);
    await client.query('COMMIT');
    return { ...plan, reset: result.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function main(argv = process.argv.slice(2), database = db) {
  const confirmed = argv.includes(CONFIRM_FLAG);
  const allowDerivedDataReset = argv.includes(DERIVED_DATA_CONFIRM_FLAG);
  if (allowDerivedDataReset && !confirmed) {
    throw new Error(`${DERIVED_DATA_CONFIRM_FLAG} requires ${CONFIRM_FLAG}`);
  }
  const result = confirmed
    ? await resetMarketReplay(database, { allowDerivedDataReset })
    : await inspectMarketReplay(database);
  console.log(JSON.stringify({ mode: confirmed ? 'reset' : 'dry-run', ...result }, null, 2));
  if (!confirmed) {
    console.log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
    if (result.hasAcceptedObservations || result.hasBucketRows) {
      console.log(`A full rebuild also requires ${DERIVED_DATA_CONFIRM_FLAG}.`);
    }
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood market replay reset failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = {
  CONFIRM_FLAG,
  DERIVED_DATA_CONFIRM_FLAG,
  INSPECT_SQL,
  RESET_SQL,
  assertReplayIsSafe,
  inspectMarketReplay,
  main,
  planFromRow,
  resetMarketReplay,
};
