const db = require('../models/db');

const CONFIRM_FLAG = '--confirm-skip-robinhood-market-cursor';
const TARGET_FLAG_PREFIX = '--target-block=';
const LOCK_ID = 4663003;
const INSPECT_SQL = `SELECT
  EXISTS (
    SELECT 1 FROM worker_leases
    WHERE lease_key = 'robinhood-ingestion-worker' AND lease_until > NOW()
  ) AS live_worker,
  (SELECT next_block::text FROM robinhood_ingestion_cursors
    WHERE chain = 'robinhood' AND stream = 'market') AS market_next_block,
  (SELECT version::text FROM robinhood_ingestion_cursors
    WHERE chain = 'robinhood' AND stream = 'market') AS market_version,
  (SELECT next_block::text FROM robinhood_ingestion_cursors
    WHERE chain = 'robinhood' AND stream = 'discovery') AS discovery_next_block,
  (SELECT COUNT(*)::int FROM robinhood_pool_registry
    WHERE chain = 'robinhood') AS pools`;
const SKIP_SQL = `UPDATE robinhood_ingestion_cursors
  SET next_block = $1,
      safe_head = NULL,
      checkpoint_block = NULL,
      checkpoint_hash = NULL,
      checkpoint_timestamp = NULL,
      version = version + 1,
      updated_at = NOW()
  WHERE chain = 'robinhood' AND stream = 'market'
  RETURNING next_block::text, version::text`;

function parseBlock(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(text);
}

function planFromRow(row = {}) {
  return {
    liveWorker: row.live_worker === true,
    marketNextBlock: row.market_next_block ?? null,
    marketVersion: row.market_version ?? null,
    discoveryNextBlock: row.discovery_next_block ?? null,
    pools: Number(row.pools || 0),
  };
}

async function inspectMarketSkip(database = db) {
  const result = typeof database.queryWithStatementTimeout === 'function'
    ? await database.queryWithStatementTimeout(INSPECT_SQL, [], 10_000)
    : await database.query(INSPECT_SQL);
  return planFromRow(result.rows[0]);
}

function resolveTargetBlock(plan, requestedTarget = null) {
  if (plan.marketNextBlock == null) throw new Error('Robinhood market cursor is absent');
  if (plan.discoveryNextBlock == null) throw new Error('Robinhood discovery cursor is absent');
  const discoveryNext = parseBlock(plan.discoveryNextBlock, 'discovery next_block');
  const marketNext = parseBlock(plan.marketNextBlock, 'market next_block');
  const target = requestedTarget == null
    ? discoveryNext
    : parseBlock(requestedTarget, 'target block');
  if (target > discoveryNext) {
    throw new Error(
      `Target block ${target} would pass the discovery cursor at ${discoveryNext}`
    );
  }
  if (target <= marketNext) {
    throw new Error(
      `Target block ${target} does not advance the market cursor at ${marketNext}`
    );
  }
  return target;
}

function assertSkipIsSafe(plan) {
  if (plan.liveWorker) throw new Error('Robinhood ingestion lease is still active');
  if (plan.pools === 0) throw new Error('Robinhood pool registry is empty');
}

async function skipMarketCursor(database = db, options = {}) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(
      `SELECT lease_key FROM worker_leases
       WHERE lease_key = 'robinhood-ingestion-worker' FOR UPDATE`
    );
    const plan = await inspectMarketSkip(client);
    assertSkipIsSafe(plan);
    const target = resolveTargetBlock(plan, options.targetBlock ?? null);
    const result = await client.query(SKIP_SQL, [target.toString()]);
    if (result.rows.length !== 1) throw new Error('Robinhood market cursor update did not apply');
    await client.query('COMMIT');
    return { ...plan, skip: { targetBlock: target.toString(), cursor: result.rows[0] } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function parseArgs(argv = []) {
  const confirmed = argv.includes(CONFIRM_FLAG);
  const targetArg = argv.find((arg) => arg.startsWith(TARGET_FLAG_PREFIX));
  const targetBlock = targetArg == null ? null : targetArg.slice(TARGET_FLAG_PREFIX.length);
  return { confirmed, targetBlock };
}

async function main(argv = process.argv.slice(2), database = db) {
  const { confirmed, targetBlock } = parseArgs(argv);
  let result;
  if (confirmed) {
    result = await skipMarketCursor(database, { targetBlock });
  } else {
    const plan = await inspectMarketSkip(database);
    const target = resolveTargetBlock(plan, targetBlock);
    result = { ...plan, skip: { targetBlock: target.toString(), cursor: null } };
  }
  console.log(JSON.stringify({ mode: confirmed ? 'skip' : 'dry-run', ...result }, null, 2));
  if (!confirmed) {
    console.log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
    if (result.liveWorker) {
      console.log('The confirmed run will refuse until the live ingestion service is stopped.');
    }
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood market cursor skip failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = {
  CONFIRM_FLAG,
  INSPECT_SQL,
  SKIP_SQL,
  assertSkipIsSafe,
  inspectMarketSkip,
  main,
  planFromRow,
  resolveTargetBlock,
  skipMarketCursor,
};
