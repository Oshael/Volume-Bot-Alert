const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const db = require('../models/db');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { isAdaptiveRangeError, toQuantity } = require('../services/evm-log-poller');
const v3 = require('../services/uniswap-v3-decoder');
const repair = require('./repair-robinhood-v3-pruned-captures').__private;

const CHAIN_ID = 4663n;
const LOCK_KEY = 'robinhood:v3-archive-reconstruct';
const CHECKPOINT_VERSION = 1;
const SUMMARY_COUNTERS = [
  'scannedBlocks', 'archiveSwapLogs', 'trackedSwapLogs', 'existingProcessed',
  'existingCaptures', 'missing', 'repaired', 'accepted', 'rejected', 'failed', 'ranges',
];

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
    rpcBatchSize: integer(args['rpc-batch-size'], 25, 1, 100, 'rpc-batch-size'),
    enrichmentConcurrency: integer(
      args['enrichment-concurrency'], 2, 1, 4, 'enrichment-concurrency'
    ),
    maxRanges: integer(args['max-ranges'], 0, 0, 10_000_000, 'max-ranges'),
    sleepMs: integer(args['sleep-ms'], 100, 0, 60_000, 'sleep-ms'),
    checkpointFile: String(
      args['checkpoint-file'] || env.ROBINHOOD_V3_RECONSTRUCTION_CHECKPOINT_FILE || ''
    ).trim() || null,
  };
}

function emptySummary(mode) {
  return {
    mode, scannedBlocks: 0, archiveSwapLogs: 0, trackedSwapLogs: 0,
    existingProcessed: 0, existingCaptures: 0, missing: 0,
    repaired: 0, accepted: 0, rejected: 0, failed: 0, ranges: 0,
  };
}

function restoreCheckpoint(saved, options) {
  if (!saved || saved.version !== CHECKPOINT_VERSION) {
    throw new Error('Checkpoint version is invalid');
  }
  for (const key of ['mode', 'fromBlock', 'toBlock']) {
    if (String(saved[key]) !== String(options[key])) {
      throw new Error(`Checkpoint ${key} does not match this execution`);
    }
  }
  const nextBlock = requiredBlock(saved.nextBlock, 'checkpoint nextBlock');
  const minimum = BigInt(options.fromBlock);
  const maximum = BigInt(options.toBlock) + 1n;
  if (BigInt(nextBlock) < minimum || BigInt(nextBlock) > maximum) {
    throw new Error('Checkpoint nextBlock is outside the requested interval');
  }
  const summary = emptySummary(options.mode);
  for (const key of SUMMARY_COUNTERS) {
    const value = Number(saved.summary?.[key]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Checkpoint summary.${key} is invalid`);
    }
    summary[key] = value;
  }
  return { nextBlock, summary };
}

function createCheckpointStore(filename) {
  if (!filename) return Object.freeze({ load: async () => null, save: async () => {} });
  const resolved = path.resolve(filename);
  return Object.freeze({
    load: async () => {
      try {
        return JSON.parse(await fs.readFile(resolved, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`Cannot read checkpoint ${resolved}: ${error.message}`);
      }
    },
    save: async (checkpoint) => {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.tmp-${process.pid}`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, resolved);
      } finally {
        await fs.unlink(temporary).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    },
  });
}

function checkpointState(options, cursor, summary) {
  return {
    version: CHECKPOINT_VERSION,
    mode: options.mode,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    nextBlock: cursor.toString(),
    completed: cursor > BigInt(options.toBlock),
    updatedAt: new Date().toISOString(),
    summary,
  };
}

async function resumeState(checkpoint, options) {
  const saved = await checkpoint.load();
  if (!saved) {
    return { nextBlock: options.fromBlock, summary: emptySummary(options.mode) };
  }
  return restoreCheckpoint(saved, options);
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

function mergeBuilt(left, right, splitRetries) {
  const metrics = [left.rpc, right.rpc].filter(Boolean);
  const keys = ['batches', 'batchItems', 'individualRequests', 'batchFallbacks'];
  return {
    entries: [...left.entries, ...right.entries],
    repairedRows: [...(left.repairedRows || []), ...(right.repairedRows || [])],
    failures: [...(left.failures || []), ...(right.failures || [])],
    rpc: Object.fromEntries(keys.map((key) => [
      key, metrics.reduce((total, metric) => total + Number(metric[key] || 0), 0),
    ]).concat([['splitRetries', splitRetries]])),
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  let index = 0;
  const output = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      output[current] = await mapper(items[current], current);
    }
  }));
  return output;
}

function chunks(rows, size) {
  const output = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    output.push(rows.slice(offset, offset + size));
  }
  return output;
}

function combinedRpc(builds) {
  const keys = [
    'batches', 'batchItems', 'individualRequests', 'batchFallbacks', 'splitRetries',
  ];
  return Object.fromEntries(keys.map((key) => [
    key, builds.reduce((total, built) => total + Number(built.rpc?.[key] || 0), 0),
  ]));
}

async function enrichResilient(rows, enrichBatch) {
  try {
    return await enrichBatch(rows);
  } catch (error) {
    if (error?.rpcCode !== -32000) throw error;
    if (rows.length === 1) return {
      entries: [], repairedRows: [], failures: [{ row: rows[0], error }],
      rpc: { splitRetries: 1 },
    };
    const midpoint = Math.ceil(rows.length / 2);
    const left = await enrichResilient(rows.slice(0, midpoint), enrichBatch);
    const right = await enrichResilient(rows.slice(midpoint), enrichBatch);
    return mergeBuilt(left, right, 1 + Number(left.rpc?.splitRetries || 0)
      + Number(right.rpc?.splitRetries || 0));
  }
}

async function runReconstruction(options, deps = {}) {
  if (!options.rpcUrl && !deps.rpcClient) throw new Error('Archive RPC URL is required');
  const repository = deps.repository || createRepository(deps.database || db);
  const rpcClient = deps.rpcClient || repair.createArchiveClient(options.rpcUrl);
  const persistence = deps.persistence || createRobinhoodPersistenceRepository();
  const enrichBatch = deps.enrichBatch || ((rows) => repair.enrich(rows, rpcClient, options));
  const checkpoint = deps.checkpoint || createCheckpointStore(options.checkpointFile);
  const pools = poolIndex(await repository.listPools());
  return repository.withLock(async () => {
    if (BigInt(await rpcClient.request('eth_chainId')) !== CHAIN_ID) {
      throw new Error('Archive RPC is not on Robinhood Chain');
    }
    const resumed = await resumeState(checkpoint, options);
    const summary = resumed.summary;
    let cursor = BigInt(resumed.nextBlock);
    const end = BigInt(options.toBlock);
    let runRanges = 0;
    while (cursor <= end && (options.maxRanges === 0 || runRanges < options.maxRanges)) {
      const requestedEnd = cursor + BigInt(options.rangeSize) - 1n;
      const ranges = await fetchRanges(
        rpcClient, cursor, requestedEnd < end ? requestedEnd : end, options.minRangeSize
      );
      for (const range of ranges) {
        const workStarted = performance.now();
        const rows = trackedRows(range.logs, pools);
        const classifyStarted = performance.now();
        const classified = await repository.classify(rows);
        const classifyMs = performance.now() - classifyStarted;
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
        let enrichMs = 0;
        let persistMs = 0;
        if (options.mode === 'write') {
          const enrichmentStarted = performance.now();
          const builtChunks = await mapConcurrent(
            chunks(missing, options.batchSize),
            options.enrichmentConcurrency || 1,
            (chunk) => enrichResilient(chunk, enrichBatch)
          );
          enrichMs = performance.now() - enrichmentStarted;
          const persistenceStarted = performance.now();
          const rangeFailures = [];
          for (const built of builtChunks) {
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
            rangeFailures.push(...(built.failures || []));
          }
          persistMs = performance.now() - persistenceStarted;
          summary.lastRpc = combinedRpc(builtChunks);
          summary.lastFailures = rangeFailures.slice(-10).map(({ row, error }) => ({
            transactionHash: row.transaction_hash,
            logIndex: row.log_index,
            blockNumber: row.block_number,
            error: String(error?.message || error).slice(0, 500),
          }));
        }
        summary.lastRange = {
          blocks: Number(range.toBlock - range.fromBlock + 1n),
          archiveSwapLogs: range.logs.length,
          trackedSwapLogs: rows.length,
          missing: missing.length,
          chunks: Math.ceil(missing.length / options.batchSize),
          classifyMs: Math.round(classifyMs),
          enrichMs: Math.round(enrichMs),
          persistMs: Math.round(persistMs),
          workMs: Math.round(performance.now() - workStarted),
        };
        summary.ranges += 1;
        runRanges += 1;
        cursor = range.toBlock + 1n;
        await checkpoint.save(checkpointState(options, cursor, summary));
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
  __private: {
    chunks, combinedRpc, createCheckpointStore, createRepository, enrichResilient,
    fetchRanges, mapConcurrent, parseArgs, poolIndex, restoreCheckpoint, resumeState,
    trackedRows,
  },
};
