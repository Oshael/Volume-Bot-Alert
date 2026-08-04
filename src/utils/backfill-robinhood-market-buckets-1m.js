const db = require('../models/db');

// Recovery util: rebuild robinhood_market_buckets_1m for a range of already
// persisted market observations. Used when the live ingestion cursor halted and
// its 1m buckets never got written, even though robinhood-processing had already
// captured the observations. It re-aggregates from observations only (no node,
// no eth_call), so a pruned node is irrelevant.
//
// Strategy: DELETE + rebuild every affected minute from ALL of its accepted
// observations, inside one transaction. This is idempotent (rerunning yields the
// same buckets) unlike the live SUM-on-conflict upsert. The current (live) minute
// is excluded so the write never races the resumed live ingestion.

const AGGREGATION_SELECT = `
  SELECT
    chain, protocol, market_key, token_address, quote_address,
    date_trunc('minute', observed_at) AS bucket_ts,
    (array_agg(price_usd ORDER BY block_number, log_index))[1] AS open_price_usd,
    MAX(price_usd) AS high_price_usd,
    MIN(price_usd) AS low_price_usd,
    (array_agg(price_usd ORDER BY block_number DESC, log_index DESC))[1] AS close_price_usd,
    (array_agg(fdv_usd ORDER BY block_number, log_index))[1] AS open_fdv_usd,
    MAX(fdv_usd) AS high_fdv_usd,
    MIN(fdv_usd) AS low_fdv_usd,
    (array_agg(fdv_usd ORDER BY block_number DESC, log_index DESC))[1] AS close_fdv_usd,
    (array_agg(liquidity_usd ORDER BY block_number DESC, log_index DESC))[1] AS close_liquidity_usd,
    (array_agg(liquidity_raw ORDER BY block_number DESC, log_index DESC))[1] AS close_liquidity_raw,
    (array_agg(liquidity_status ORDER BY block_number DESC, log_index DESC))[1] AS close_liquidity_status,
    (array_agg(liquidity_confidence ORDER BY block_number DESC, log_index DESC))[1] AS close_liquidity_confidence,
    (array_agg(liquidity_warning ORDER BY block_number DESC, log_index DESC))[1] AS close_liquidity_warning,
    SUM(volume_usd) AS volume_usd,
    COUNT(*)::bigint AS swaps,
    COUNT(*) FILTER (WHERE side = 'buy') AS buys,
    COUNT(*) FILTER (WHERE side = 'sell') AS sells,
    COUNT(DISTINCT transaction_hash)::bigint AS transactions,
    (array_agg(observed_at ORDER BY block_number, log_index))[1] AS first_observed_at,
    MIN(block_number) AS first_block_number,
    (array_agg(log_index ORDER BY block_number, log_index))[1] AS first_log_index,
    (array_agg(observed_at ORDER BY block_number DESC, log_index DESC))[1] AS last_observed_at,
    MAX(block_number) AS last_block_number,
    (array_agg(log_index ORDER BY block_number DESC, log_index DESC))[1] AS last_log_index,
    date_trunc('minute', observed_at) + INTERVAL '14 days' AS expires_at
  FROM robinhood_market_observations
  WHERE chain = 'robinhood' AND status = 'accepted'
    AND observed_at >= $1::timestamptz AND observed_at < $2::timestamptz
  GROUP BY chain, protocol, market_key, token_address, quote_address,
    date_trunc('minute', observed_at)
`;

const WINDOW_SQL = `
  SELECT
    date_trunc('minute', MIN(observed_at)) AS start_ts,
    LEAST(
      date_trunc('minute', NOW()),
      date_trunc('minute', MAX(observed_at)) + INTERVAL '1 minute'
    ) AS end_ts
  FROM robinhood_market_observations
  WHERE chain = 'robinhood' AND status = 'accepted'
    AND block_number > $1::bigint
    AND ($2::bigint IS NULL OR block_number <= $2::bigint)
`;

const PREVIEW_SQL = `
  WITH scoped AS (
    SELECT protocol, market_key,
      date_trunc('minute', observed_at) AS bucket_ts, volume_usd
    FROM robinhood_market_observations
    WHERE chain = 'robinhood' AND status = 'accepted'
      AND observed_at >= $1::timestamptz AND observed_at < $2::timestamptz
  )
  SELECT
    COUNT(DISTINCT bucket_ts) AS minutes,
    COUNT(DISTINCT (protocol, market_key, bucket_ts)) AS buckets,
    COALESCE(SUM(volume_usd), 0)::text AS volume_usd
  FROM scoped
`;

const DELETE_SQL = `
  DELETE FROM robinhood_market_buckets_1m
  WHERE chain = 'robinhood'
    AND bucket_ts >= $1::timestamptz AND bucket_ts < $2::timestamptz
`;

const INSERT_SQL = `
  INSERT INTO robinhood_market_buckets_1m (
    chain, protocol, market_key, token_address, quote_address, bucket_ts,
    open_price_usd, high_price_usd, low_price_usd, close_price_usd,
    open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
    close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
    close_liquidity_confidence, close_liquidity_warning,
    volume_usd, swaps, buys, sells, transactions, first_observed_at, first_block_number,
    first_log_index, last_observed_at, last_block_number, last_log_index, expires_at
  )
  ${AGGREGATION_SELECT}
`;

function parseRequiredInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const next = argv[index + 1];
    args[key.slice(2)] = !next || next.startsWith('--') ? true : next;
    if (args[key.slice(2)] !== true) index += 1;
  }

  const mode = String(args.mode || 'dry-run').trim().toLowerCase();
  if (!['dry-run', 'write'].includes(mode)) {
    throw new Error('mode must be dry-run or write');
  }
  if (args['from-block'] == null || args['from-block'] === true) {
    throw new Error('--from-block <lastCommittedBlock> is required');
  }
  const fromBlock = parseRequiredInt(args['from-block'], 'from-block');
  const toBlock = args['to-block'] == null || args['to-block'] === true
    ? null
    : parseRequiredInt(args['to-block'], 'to-block');
  if (toBlock != null && toBlock <= fromBlock) {
    throw new Error('--to-block must be greater than --from-block');
  }
  if (mode === 'write' && toBlock == null) {
    throw new Error('write mode requires --to-block to keep the transaction bounded');
  }
  return { mode, fromBlock, toBlock };
}

async function resolveWindow(database, options) {
  const result = await database.query(WINDOW_SQL, [options.fromBlock, options.toBlock]);
  const row = result.rows[0] || {};
  if (!row.start_ts || !row.end_ts || new Date(row.start_ts) >= new Date(row.end_ts)) {
    return null;
  }
  return { start: row.start_ts, end: row.end_ts };
}

async function runBackfill(options, deps = {}) {
  const database = deps.database || db;
  const window = await resolveWindow(database, options);
  if (!window) {
    return { mode: options.mode, window: null, minutes: 0, buckets: 0, volumeUsd: '0' };
  }

  const preview = await database.query(PREVIEW_SQL, [window.start, window.end]);
  const summary = {
    mode: options.mode,
    window,
    minutes: Number(preview.rows[0]?.minutes) || 0,
    buckets: Number(preview.rows[0]?.buckets) || 0,
    volumeUsd: preview.rows[0]?.volume_usd ?? '0',
  };

  if (options.mode === 'dry-run') {
    return summary;
  }

  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const deleted = await client.query(DELETE_SQL, [window.start, window.end]);
    const inserted = await client.query(INSERT_SQL, [window.start, window.end]);
    await client.query('COMMIT');
    summary.deleted = deleted.rowCount || 0;
    summary.inserted = inserted.rowCount || 0;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
  return summary;
}

async function run() {
  try {
    const options = parseCliArgs();
    const summary = await runBackfill(options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[RobinhoodBuckets1mBackfill]', error.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void run();

module.exports = {
  run,
  __private: { parseCliArgs, resolveWindow, runBackfill, INSERT_SQL, DELETE_SQL },
};
