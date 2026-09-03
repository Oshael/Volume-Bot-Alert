const { setTimeout: delay } = require('node:timers/promises');
const db = require('../models/db');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { isAdaptiveRangeError, toQuantity } = require('../services/evm-log-poller');
const v3 = require('../services/uniswap-v3-decoder');
const repair = require('./repair-robinhood-v3-pruned-captures').__private;

const CHAIN_ID = 4663n;
const LOCK_KEY = 'robinhood:v3-archive-reconstruct';

function integer(value, fallback, min, max, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return resolved;
}

function requiredBlock(value, label) {
  const resolved = String(value ?? '').trim();
  if (!/^\d+$/.test(resolved)) throw new Error(`${label} is required and must be a block`);
  return resolved;
}

function parseNamedArgs(argv) {
  return Object.fromEntries(argv.map((argument) => {
    const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    return [match[1], match[2] ?? 'true'];
  }));
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = parseNamedArgs(argv);
  const mode = String(args.mode || 'dry-run').toLowerCase();
  if (!['dry-run', 'write'].includes(mode)) throw new Error('mode must be dry-run or write');
  const fromBlock = requiredBlock(args['from-block'], 'from-block');
  const toBlock = requiredBlock(args['to-block'], 'to-block');
  if (BigInt(toBlock) < BigInt(fromBlock)) throw new Error('to-block must not precede from-block');
  return {
    mode,
    rpcUrl: String(args['rpc-url'] || env.ROBINHOOD_V3_REPAIR_RPC_URL || '').trim(),
    fromBlock,
    toBlock,
    rangeSize: integer(args['range-size'], 500, 1, 10_000, 'range-size'),
    minRangeSize: integer(args['min-range-size'], 1, 1, 10_000, 'min-range-size'),
    batchSize: integer(args['batch-size'], 500, 1, 500, 'batch-size'),
    rpcConcurrency: integer(args['rpc-concurrency'], 8, 1, 8, 'rpc-concurrency'),
    maxRanges: integer(args['max-ranges'], 0, 0, 10_000_000, 'max-ranges'),
    sleepMs: integer(args['sleep-ms'], 100, 0, 60_000, 'sleep-ms'),
  };
}

function createRepository(database = db) {
  async function listPools() {
    const result = await database.query(
      `SELECT protocol, market_key, pool_address, pool_id, origin_address,
              token_address, quote_address, currency0, currency1, fee,
              tick_spacing, metadata
         FROM robinhood_pool_registry
        WHERE chain = 'robinhood' AND protocol = 'uniswap-v3'
          AND pool_address IS NOT NULL`
    );
    return result.rows;
  }

  async function classify(rows) {
    if (!rows.length) return new Map();
    const identities = rows.map((row) => ({
      transactionHash: row.transaction_hash,
      logIndex: row.log_index,
    }));
    const result = await database.query(
      `WITH input AS MATERIALIZED (
         SELECT lower(item."transactionHash") AS transaction_hash,
                item."logIndex"::bigint AS log_index
           FROM jsonb_to_recordset($1::jsonb) AS item(
             "transactionHash" text, "logIndex" text
           )
       )
       SELECT input.transaction_hash, input.log_index::text,
         EXISTS (
           SELECT 1 FROM robinhood_processed_logs processed
            WHERE processed.chain = 'robinhood'
              AND processed.transaction_hash = input.transaction_hash
              AND processed.log_index = input.log_index
         ) AS processed,
         EXISTS (
           SELECT 1 FROM robinhood_head_captures capture
            WHERE capture.chain = 'robinhood'
              AND capture.transaction_hash = input.transaction_hash
              AND capture.log_index = input.log_index
         ) AS captured
       FROM input`,
      [JSON.stringify(identities)]
    );
    return new Map(result.rows.map((row) => [
      `${row.transaction_hash}:${row.log_index}`,
      { processed: row.processed, captured: row.captured },
    ]));
  }

  async function withLock(callback) {
    const client = await database.getClient();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
      return await callback();
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); } catch (_) {}
      client.release();
    }
  }

  return Object.freeze({ classify, listPools, withLock });
}

function poolIndex(rows) {
  return new Map(rows.map((row) => [String(row.pool_address).toLowerCase(), row]));
}

function trackedRows(logs, pools) {
  const unique = new Map();
  for (const log of logs) {
    if (log?.removed === true) continue;
    const registry = pools.get(String(log?.address || '').toLowerCase());
    if (!registry) continue;
    const row = {
      transaction_hash: String(log.transactionHash).toLowerCase(),
      log_index: BigInt(log.logIndex).toString(),
      block_number: BigInt(log.blockNumber).toString(),
      block_hash: String(log.blockHash).toLowerCase(),
      transaction_index: BigInt(log.transactionIndex).toString(),
      address: String(log.address).toLowerCase(),
      topics: log.topics,
      data: log.data,
      protocol: 'uniswap-v3',
      market_key: registry.market_key,
      registry_market_key: registry.market_key,
      ...registry,
    };
    unique.set(`${row.transaction_hash}:${row.log_index}`, row);
  }
  return [...unique.values()].sort((left, right) => (
    Number(BigInt(left.block_number) - BigInt(right.block_number))
      || Number(BigInt(left.log_index) - BigInt(right.log_index))
  ));
}

async function fetchRanges(rpcClient, fromBlock, toBlock, minRangeSize, maxLogs = 10_000) {
  let logs;
  try {
    logs = await rpcClient.request('eth_getLogs', [{
      fromBlock: toQuantity(fromBlock),
      toBlock: toQuantity(toBlock),
      topics: [v3.TOPICS.swap],
    }]);
    if (!Array.isArray(logs)) throw new Error('eth_getLogs did not return an array');
  } catch (error) {
    const splittable = isAdaptiveRangeError(error) || error?.rpcCode === -32000;
    if (!splittable || toBlock - fromBlock + 1n <= BigInt(minRangeSize)) throw error;
    logs = null;
  }
  if (logs && logs.length <= maxLogs) return [{ fromBlock, toBlock, logs }];
  if (toBlock - fromBlock + 1n <= BigInt(minRangeSize)) {
    throw new Error('Dense archive range cannot be split below min-range-size');
  }
  const midpoint = fromBlock + ((toBlock - fromBlock) / 2n);
  return [
    ...await fetchRanges(rpcClient, fromBlock, midpoint, minRangeSize, maxLogs),
    ...await fetchRanges(rpcClient, midpoint + 1n, toBlock, minRangeSize, maxLogs),
  ];
}

function entryStatus(row, classified) {
  return classified.get(`${row.transaction_hash}:${row.log_index}`)
    || { processed: false, captured: false };
}

function progress(summary, cursor, options) {
  const total = BigInt(options.toBlock) - BigInt(options.fromBlock) + 1n;
  const done = cursor - BigInt(options.fromBlock) + 1n;
  return {
    ...summary,
    nextBlock: (cursor + 1n).toString(),
    progressPct: Number(((Number(done) / Number(total)) * 100).toFixed(2)),
  };
}

async function runReconstruction(options, deps = {}) {
  if (!options.rpcUrl && !deps.rpcClient) throw new Error('Archive RPC URL is required');
  const repository = deps.repository || createRepository(deps.database || db);
  const rpcClient = deps.rpcClient || repair.createArchiveClient(options.rpcUrl);
  const persistence = deps.persistence || createRobinhoodPersistenceRepository();
  const enrichBatch = deps.enrichBatch || ((rows) => repair.enrich(rows, rpcClient, options));
  const pools = poolIndex(await repository.listPools());
  const summary = {
    mode: options.mode, scannedBlocks: 0, archiveSwapLogs: 0, trackedSwapLogs: 0,
    existingProcessed: 0, existingCaptures: 0, missing: 0,
    repaired: 0, accepted: 0, rejected: 0, failed: 0, ranges: 0,
  };
  return repository.withLock(async () => {
    if (BigInt(await rpcClient.request('eth_chainId')) !== CHAIN_ID) {
      throw new Error('Archive RPC is not on Robinhood Chain');
    }
    let cursor = BigInt(options.fromBlock);
    const end = BigInt(options.toBlock);
    while (cursor <= end && (options.maxRanges === 0 || summary.ranges < options.maxRanges)) {
      const requestedEnd = cursor + BigInt(options.rangeSize) - 1n;
      const ranges = await fetchRanges(
        rpcClient, cursor, requestedEnd < end ? requestedEnd : end, options.minRangeSize
      );
      for (const range of ranges) {
        const rows = trackedRows(range.logs, pools);
        const classified = await repository.classify(rows);
        const missing = rows.filter((row) => {
          const status = entryStatus(row, classified);
          if (status.processed) summary.existingProcessed += 1;
          else if (status.captured) summary.existingCaptures += 1;
          return !status.processed && !status.captured;
        });
        summary.scannedBlocks += Number(range.toBlock - range.fromBlock + 1n);
        summary.archiveSwapLogs += range.logs.length;
        summary.trackedSwapLogs += rows.length;
        summary.missing += missing.length;
        if (options.mode === 'write') {
          for (let offset = 0; offset < missing.length; offset += options.batchSize) {
            const built = await enrichBatch(missing.slice(offset, offset + options.batchSize));
            const committed = built.entries.length
              ? await persistence.commitHeadProcessingBatch({ entries: built.entries })
              : { insertedLogs: 0 };
            summary.repaired += committed.insertedLogs;
            summary.accepted += built.entries.filter((entry) => entry.observation?.accepted).length;
            summary.rejected += built.entries.filter(
              (entry) => entry.observation?.accepted === false
            ).length;
            summary.failed += built.failures?.length || 0;
            summary.lastCommit = committed;
            summary.lastRpc = built.rpc;
            summary.lastFailures = (built.failures || []).slice(0, 10).map(({ row, error }) => ({
              transactionHash: row.transaction_hash,
              logIndex: row.log_index,
              blockNumber: row.block_number,
              error: String(error?.message || error).slice(0, 500),
            }));
          }
        }
        summary.ranges += 1;
        cursor = range.toBlock + 1n;
        console.log(JSON.stringify({
          event: 'v3_archive_reconstruction_progress',
          ...progress(summary, range.toBlock, options),
        }));
        if (options.sleepMs) await delay(options.sleepMs);
      }
    }
    return progress(summary, cursor - 1n, options);
  });
}

async function run() {
  try {
    console.log(JSON.stringify(await runReconstruction(parseArgs()), null, 2));
  } catch (error) {
    console.error('[RobinhoodV3ArchiveReconstruction]', error.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void run();

module.exports = {
  runReconstruction,
  __private: { createRepository, fetchRanges, parseArgs, poolIndex, trackedRows },
};
