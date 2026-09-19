'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  backfillRange,
} = require('../models/robinhood-stock-usd-reference-journal');
const {
  createRobinhoodPoolLiquiditySnapshotRepository,
} = require('../models/robinhood-pool-liquidity-snapshot');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createRobinhoodWethUsdQuoteReader } = require('../services/robinhood-weth-usd-quote');

const BATCH_BLOCKS = 2_000n;
const DEFAULT_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

async function syncWethUsdPools(database, deps = {}) {
  const repository = deps.repository
    || createRobinhoodPoolLiquiditySnapshotRepository({ database });
  const rpcUrl = String(deps.rpcUrl || process.env.ROBINHOOD_CANONICAL_HEAD_RPC_URL
    || process.env.ROBINHOOD_CHAIN_CAPTURE_RPC_URL || '').trim();
  if (!rpcUrl && !deps.rpcClient) {
    throw new Error('ROBINHOOD_CANONICAL_HEAD_RPC_URL is required');
  }
  const rpcClient = deps.rpcClient || createEvmJsonRpcClient({
    providers: [{ name: 'live', url: rpcUrl }], timeoutMs: 60_000, maxRetries: 2,
  });
  const pools = await createRobinhoodWethUsdQuoteReader({
    rpcClient, checkpointRepository: repository, eventFallbackEnabled: false,
  }).syncReferencePools();
  return pools.length;
}

async function window(database) {
  const { rows } = await database.query(
    `SELECT cursor.checkpoint_block AS through_block,
            COALESCE((SELECT outbox.block_number
              FROM robinhood_chain_domain_outbox outbox
             WHERE outbox.chain='robinhood' AND outbox.status<>'complete'
             ORDER BY outbox.block_number LIMIT 1), cursor.checkpoint_block) AS frontier_block
       FROM robinhood_chain_capture_cursor cursor WHERE cursor.chain='robinhood'`
  );
  if (rows[0]?.through_block == null) throw new Error('canonical capture cursor is unavailable');
  const frontier = BigInt(rows[0].frontier_block);
  const retained = await database.query(
    `SELECT MIN(block_number)::text AS first_block
       FROM robinhood_chain_blocks WHERE chain='robinhood' AND canonical=TRUE`
  );
  if (retained.rows[0]?.first_block == null) throw new Error('canonical block journal is empty');
  let low = BigInt(retained.rows[0].first_block);
  let high = frontier;
  if (low > high) throw new Error('canonical frontier is below retained block coverage');
  const target = await database.query(
    `SELECT block_timestamp FROM robinhood_chain_blocks
      WHERE chain='robinhood' AND canonical=TRUE AND block_number=$1`,
    [frontier.toString()]
  );
  const targetMs = new Date(target.rows[0]?.block_timestamp).getTime();
  if (!Number.isFinite(targetMs)) throw new Error('frontier block timestamp is unavailable');
  const cutoffMs = targetMs - DEFAULT_LOOKBACK_MS;
  while (low < high) {
    const middle = (low + high) / 2n;
    const probe = await database.query(
      `SELECT block_timestamp FROM robinhood_chain_blocks
        WHERE chain='robinhood' AND canonical=TRUE AND block_number=$1`,
      [middle.toString()]
    );
    const observedMs = new Date(probe.rows[0]?.block_timestamp).getTime();
    if (!Number.isFinite(observedMs)) throw new Error(`canonical block ${middle} is missing`);
    if (observedMs < cutoffMs) low = middle + 1n;
    else high = middle;
  }
  return {
    from: low,
    through: BigInt(rows[0].through_block),
  };
}

async function main(args = process.argv.slice(2), deps = {}) {
  if (args.length !== 1 || args[0] !== '--write') throw new Error('--write is required');
  const database = deps.database || db;
  const logger = deps.logger || console;
  try {
    const wethUsdPools = await syncWethUsdPools(database, deps);
    const bounds = await window(database);
    let inserted = 0;
    let batches = 0;
    for (let first = bounds.from; first <= bounds.through;) {
      const last = first + BATCH_BLOCKS - 1n > bounds.through
        ? bounds.through : first + BATCH_BLOCKS - 1n;
      const count = await backfillRange({
        fromBlock: first.toString(), throughBlock: last.toString(),
      }, { database });
      inserted += count; batches += 1;
      logger.log(JSON.stringify({ phase: 'batch', batch: batches,
        throughBlock: last.toString(), inserted: count, totalInserted: inserted }));
      first = last + 1n;
    }
    const result = { phase: 'summary', fromBlock: bounds.from.toString(),
      throughBlock: bounds.through.toString(), batches, inserted, wethUsdPools };
    logger.log(JSON.stringify(result));
    return result;
  } finally {
    if (!deps.database) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ phase: 'error', message: error.message }));
  process.exitCode = 1;
});

module.exports = { DEFAULT_LOOKBACK_MS, main, syncWethUsdPools, window };
