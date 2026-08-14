const config = require('../../config');
const db = require('../models/db');
const {
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');

const CONFIRM_FLAG = '--confirm-bootstrap-robinhood-wallet-swap-live';
const LEASE_KEY = 'robinhood-wallet-swap-live-worker';
const LOCK_ID = 4663091;
const INSPECT_SQL = `WITH
  seed AS (
    SELECT next_block, safe_head, version
    FROM robinhood_wallet_swap_cursors
    WHERE chain = 'robinhood' AND stream = 'seed'
  ),
  live AS (
    SELECT next_block, safe_head, version
    FROM robinhood_wallet_swap_cursors
    WHERE chain = 'robinhood' AND stream = 'live'
  ),
  market AS (
    SELECT next_block
    FROM robinhood_ingestion_cursors
    WHERE chain = 'robinhood' AND stream = 'market'
  ),
  seed_audit AS (
    SELECT COUNT(*)::text AS missing_count,
           MIN(observation.block_number)::text AS min_block,
           MAX(observation.block_number)::text AS max_block
    FROM robinhood_market_observations observation
    WHERE observation.chain = 'robinhood'
      AND observation.status = 'accepted'
      AND observation.block_number <= (SELECT safe_head FROM seed)
      AND NOT EXISTS (
        SELECT 1 FROM robinhood_wallet_swaps wallet_swap
        WHERE wallet_swap.chain = observation.chain
          AND wallet_swap.transaction_hash = observation.transaction_hash
          AND wallet_swap.action_index = observation.log_index
      )
  ),
  gap AS (
    SELECT MIN(observation.block_number)::text AS oldest_needed_block
    FROM robinhood_market_observations observation
    WHERE observation.chain = 'robinhood'
      AND observation.status = 'accepted'
      AND observation.block_number > (SELECT safe_head FROM seed)
      AND observation.block_number < (SELECT next_block FROM market)
  )
SELECT
  EXISTS (SELECT 1 FROM worker_leases
    WHERE lease_key = '${LEASE_KEY}' AND lease_until > NOW()) AS live_worker_active,
  (SELECT next_block::text FROM seed) AS seed_next_block,
  (SELECT safe_head::text FROM seed) AS seed_safe_head,
  (SELECT version::text FROM seed) AS seed_version,
  (SELECT next_block::text FROM live) AS live_next_block,
  (SELECT safe_head::text FROM live) AS live_safe_head,
  (SELECT version::text FROM live) AS live_version,
  (SELECT next_block::text FROM market) AS market_next_block,
  seed_audit.missing_count AS accepted_without_wallet,
  seed_audit.min_block AS missing_min_block,
  seed_audit.max_block AS missing_max_block,
  gap.oldest_needed_block
FROM seed_audit CROSS JOIN gap`;
const INSERT_SQL = `INSERT INTO robinhood_wallet_swap_cursors (
    chain, stream, origin_block, next_block, safe_head
  ) VALUES ('robinhood', 'live', $1::bigint, $1::bigint, NULL)
  ON CONFLICT (chain, stream) DO NOTHING
  RETURNING next_block::text, safe_head::text, version::text`;
const LOAD_LIVE_SQL = `SELECT next_block::text, safe_head::text, version::text
  FROM robinhood_wallet_swap_cursors
  WHERE chain = 'robinhood' AND stream = 'live'`;

function decimalQuantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new Error(`${label} must be a non-negative quantity`);
  }
  return BigInt(raw).toString();
}

function planFromRow(row = {}) {
  const seedSafeHead = row.seed_safe_head == null ? null : String(row.seed_safe_head);
  return {
    liveWorkerActive: row.live_worker_active === true,
    seed: {
      nextBlock: row.seed_next_block == null ? null : String(row.seed_next_block),
      safeHead: seedSafeHead,
      version: row.seed_version == null ? null : String(row.seed_version),
    },
    live: {
      nextBlock: row.live_next_block == null ? null : String(row.live_next_block),
      safeHead: row.live_safe_head == null ? null : String(row.live_safe_head),
      version: row.live_version == null ? null : String(row.live_version),
    },
    marketNextBlock: row.market_next_block == null ? null : String(row.market_next_block),
    acceptedWithoutWallet: String(row.accepted_without_wallet || '0'),
    missingMinBlock: row.missing_min_block == null ? null : String(row.missing_min_block),
    missingMaxBlock: row.missing_max_block == null ? null : String(row.missing_max_block),
    oldestNeededBlock: row.oldest_needed_block == null
      ? null : String(row.oldest_needed_block),
    proposedNextBlock: seedSafeHead == null ? null : (BigInt(seedSafeHead) + 1n).toString(),
  };
}

async function inspectDatabase(database = db) {
  const result = typeof database.queryWithStatementTimeout === 'function'
    ? await database.queryWithStatementTimeout(INSPECT_SQL, [], 300_000)
    : await database.query(INSPECT_SQL);
  return planFromRow(result.rows[0]);
}

function assertBootstrapSafe(plan, options = {}) {
  if (plan.liveWorkerActive) throw new Error('wallet-swap LIVE worker lease is active');
  if (plan.seed.nextBlock == null || plan.seed.safeHead == null) {
    throw new Error('wallet-swap seed cursor is incomplete');
  }
  if (plan.marketNextBlock == null) throw new Error('Robinhood market cursor is absent');
  if (BigInt(plan.acceptedWithoutWallet) > 0n) {
    throw new Error(
      `seed audit found ${plan.acceptedWithoutWallet} accepted observations without wallet `
      + `in blocks ${plan.missingMinBlock}..${plan.missingMaxBlock}`
    );
  }
  if (plan.live.nextBlock != null && options.allowExistingLive !== true) {
    throw new Error('wallet-swap LIVE cursor already exists; inspection only');
  }
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

async function inspectNode(client, oldestNeededBlock, deps = {}) {
  const validateChainIds = deps.validateChainIds || validateRobinhoodProviderChainIds;
  const providerChainIds = await validateChainIds(client);
  const [rawHead, syncing] = await Promise.all([
    client.request('eth_blockNumber'), client.request('eth_syncing'),
  ]);
  if (syncing !== false) throw new Error('Robinhood node is still syncing');
  const nodeHead = decimalQuantity(rawHead, 'node head');
  let probedBlock = null;
  if (oldestNeededBlock != null) {
    const block = await client.request(
      'eth_getBlockByNumber', [blockTag(oldestNeededBlock), true]
    );
    if (!block || decimalQuantity(block.number, 'probe block number') !== oldestNeededBlock) {
      throw new Error(`node did not return required block ${oldestNeededBlock}`);
    }
    if (!Array.isArray(block.transactions) || block.transactions.length === 0
      || block.transactions.some((tx) => !tx || typeof tx !== 'object' || !tx.from)) {
      throw new Error(`node did not return full transactions for block ${oldestNeededBlock}`);
    }
    probedBlock = { number: oldestNeededBlock, transactions: block.transactions.length };
  }
  return { providerChainIds, nodeHead, syncing: false, probedBlock };
}

async function inspectBootstrap(database, rpcClient, deps = {}) {
  const plan = await inspectDatabase(database);
  const node = await inspectNode(rpcClient, plan.oldestNeededBlock, deps);
  if (plan.seed.safeHead != null && BigInt(node.nodeHead) < BigInt(plan.seed.safeHead)) {
    throw new Error(`Robinhood node head ${node.nodeHead} is behind seed safe head ${plan.seed.safeHead}`);
  }
  return { ...plan, node };
}

function sameBootstrapPoint(initial, fresh) {
  return initial.proposedNextBlock === fresh.proposedNextBlock
    && initial.oldestNeededBlock === fresh.oldestNeededBlock;
}

async function bootstrap(database, rpcClient, deps = {}) {
  const initial = await inspectBootstrap(database, rpcClient, deps);
  assertBootstrapSafe(initial);
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5min'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(
      `SELECT lease_key FROM worker_leases WHERE lease_key = $1 FOR UPDATE`, [LEASE_KEY]
    );
    await client.query(
      `SELECT stream FROM robinhood_wallet_swap_cursors
       WHERE chain = 'robinhood' AND stream IN ('seed', 'live') FOR UPDATE`
    );
    const fresh = await inspectDatabase(client);
    assertBootstrapSafe(fresh);
    if (!sameBootstrapPoint(initial, fresh)) {
      throw new Error('wallet-swap bootstrap state changed during preflight; rerun dry-run');
    }
    const inserted = await client.query(INSERT_SQL, [fresh.proposedNextBlock]);
    if (inserted.rows.length !== 1) throw new Error('wallet-swap LIVE cursor was not created');
    const postResult = await client.query(LOAD_LIVE_SQL);
    const post = postResult.rows[0];
    if (post?.next_block !== fresh.proposedNextBlock || post?.safe_head != null) {
      throw new Error('wallet-swap LIVE cursor post-condition failed');
    }
    await client.query('COMMIT');
    return {
      ...fresh,
      node: initial.node,
      created: {
        nextBlock: post.next_block,
        safeHead: post.safe_head,
        version: post.version,
      },
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const database = deps.database || db;
  const confirmed = argv.includes(CONFIRM_FLAG);
  const rpcClient = deps.rpcClient || (
    deps.rpcClientFactory || createRobinhoodRpcClient
  )(deps.rpcOptions || config.robinhoodIngestionWorker);
  const result = confirmed
    ? await bootstrap(database, rpcClient, deps)
    : await inspectBootstrap(database, rpcClient, deps);
  console.log(JSON.stringify({ mode: confirmed ? 'bootstrap' : 'dry-run', ...result }, null, 2));
  if (!confirmed) console.log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood wallet-swap LIVE bootstrap failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = {
  CONFIRM_FLAG,
  INSERT_SQL,
  INSPECT_SQL,
  assertBootstrapSafe,
  bootstrap,
  inspectBootstrap,
  inspectDatabase,
  inspectNode,
  main,
  planFromRow,
  __private: { blockTag, decimalQuantity, sameBootstrapPoint },
};
