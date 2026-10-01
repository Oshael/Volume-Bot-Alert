const { setTimeout: delay } = require('node:timers/promises');
const db = require('../models/db');
const { createRobinhoodPersistenceRepository, __private: persistenceRules } = require('../models/robinhood-persistence');
const { rebuildArchiveMinute } = require('../models/robinhood-archive-minute-rebuild');
const scope = require('./robinhood-archive-replay-scope');
const archive = require('../utils/reconstruct-robinhood-v3-archive').__private;
const repair = require('../utils/repair-robinhood-v3-pruned-captures').__private;

function blockClock(rpcClient) {
  const cache = new Map();
  return async (number) => {
    const key = number.toString();
    if (!cache.has(key)) {
      const block = await rpcClient.request('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]);
      if (block?.number == null || BigInt(block.number) !== number || !/^0x[0-9a-f]+$/i.test(block.timestamp || '')) {
        throw new Error('Archive block timestamp is unavailable or invalid');
      }
      if (cache.size >= 1000) cache.clear();
      cache.set(key, BigInt(block.timestamp));
    }
    return cache.get(key);
  };
}

async function firstBlockAt(clock, start, end, timestamp) {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = low + (high - low) / 2n;
    if (await clock(middle) < timestamp) low = middle + 1n;
    else high = middle;
  }
  return low;
}

async function minuteEnd(clock, cursor, end, timestamp, rangeSize) {
  let width = BigInt(rangeSize);
  let high = cursor + width < end ? cursor + width : end;
  while (high < end && await clock(high) < timestamp) {
    width *= 2n;
    high = cursor + width < end ? cursor + width : end;
  }
  return firstBlockAt(clock, cursor, high, timestamp);
}

function restore(saved, state) {
  if (!saved) return state;
  for (const key of ['version', 'mode', 'fromBlock', 'toBlock', 'poolDigest', 'anchorHash']) {
    if (saved[key] !== state[key]) throw new Error(`Stock minute checkpoint ${key} changed`);
  }
  if (!/^\d+$/.test(saved.nextBlock) || BigInt(saved.nextBlock) < BigInt(state.fromBlock)
      || BigInt(saved.nextBlock) > BigInt(state.toBlock)) throw new Error('Stock minute checkpoint cursor is invalid');
  if (![saved.minutes, saved.missing].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Stock minute checkpoint counters are invalid');
  }
  return saved;
}

async function minuteRows(rpcClient, start, end, options, pools) {
  const logs = [];
  for (let cursor = start; cursor < end; cursor += BigInt(options.rangeSize)) {
    const last = cursor + BigInt(options.rangeSize) - 1n;
    const ranges = await archive.fetchRanges(rpcClient, cursor, last < end ? last : end - 1n,
      options.minRangeSize, 10_000, scope.swapTopics('stock-quote'));
    logs.push(...ranges.flatMap((range) => range.logs));
    if (logs.length > 100_000) throw new Error('Stock minute exceeds bounded archive log budget');
  }
  const rows = archive.trackedRows(logs, pools);
  if (rows.some((row) => BigInt(row.block_number) < start || BigInt(row.block_number) >= end)) {
    throw new Error('Archive returned a swap outside the requested minute');
  }
  return rows;
}

async function persistMinute(rows, options, context, minute) {
  const classified = await context.repository.classify(rows);
  const missing = rows.filter((row) => {
    const status = classified.get(`${row.transaction_hash}:${row.log_index}`) || {};
    if (status.captured && !status.observed) throw new Error('Stock minute awaits retained capture processing/repair');
    return !status.observed;
  });
  if (options.mode === 'dry-run') return { missing: missing.length };
  const built = await archive.mapConcurrent(archive.chunks(missing, options.batchSize),
    options.enrichmentConcurrency, (chunk) => archive.enrichResilient(chunk, context.enrichBatch));
  scope.assertComplete('stock-quote', built, missing.length);
  if (built.some((chunk) => chunk.entries.some((entry) => (
    persistenceRules.PENDING_ENRICHMENT_REASONS.has(entry.observation?.reason)
  )))) throw new Error('Stock minute enrichment remains pending');
  for (const chunk of built) {
    await context.persistence.commitHeadProcessingBatch({ entries: chunk.entries, allowMissingWalletContext: true });
  }
  await scope.assertAnchor('stock-quote', context.rpcClient, context.state);
  return { missing: missing.length, ...await context.rebuild(rows, minute) };
}

async function runStockMinuteReplay(options, deps = {}) {
  if (!['dry-run', 'write'].includes(options.mode) || BigInt(options.fromBlock) > BigInt(options.toBlock)) {
    throw new Error('Stock minute replay requires a valid mode and bounded interval');
  }
  if (options.mode === 'write' && (!options.maintenancePaused || !options.checkpointFile)) {
    throw new Error('Stock minute write requires paused maintenance and a checkpoint file');
  }
  const database = deps.database || db;
  const rpcClient = deps.rpcClient || repair.createArchiveClient(options.rpcUrl);
  const repository = deps.repository || archive.createRepository(database, 'stock-quote');
  const checkpoint = deps.checkpoint || archive.createCheckpointStore(options.checkpointFile);
  return repository.withLock(async () => {
    if (BigInt(await rpcClient.request('eth_chainId')) !== 4663n) throw new Error('Archive RPC is not on Robinhood Chain');
    const clock = blockClock(rpcClient);
    const start = BigInt(options.fromBlock);
    const end = BigInt(options.toBlock);
    const startTime = await clock(start);
    if (start > 0n && await clock(start - 1n) / 60n === startTime / 60n) {
      throw new Error('Stock minute replay must start at the first block of a minute');
    }
    const cutoff = await clock(end) / 60n * 60n;
    if (cutoff > BigInt(Math.floor((deps.now || Date.now)() / 60_000)) * 60n) {
      throw new Error('Stock minute replay cutoff is in the future');
    }
    const pools = scope.poolIndex(await repository.listPools(), 'stock-quote', options.toBlock);
    let state = restore(await checkpoint.load(), {
      version: 1, mode: options.mode, fromBlock: options.fromBlock, toBlock: options.toBlock,
      poolDigest: scope.poolDigest(pools), anchorHash: await scope.anchorHash(rpcClient, options.toBlock),
      nextBlock: options.fromBlock, minutes: 0, missing: 0,
    });
    const cursorTime = await clock(BigInt(state.nextBlock));
    if (BigInt(state.nextBlock) > start && await clock(BigInt(state.nextBlock) - 1n) / 60n === cursorTime / 60n) {
      throw new Error('Stock minute checkpoint splits a minute');
    }
    const adapterOptions = repair.createStockAdapterOptions(rpcClient, database, { ...options, quotePrefetch: false });
    const context = { repository, rpcClient, state,
      persistence: deps.persistence || createRobinhoodPersistenceRepository({ database }),
      enrichBatch: deps.enrichBatch || ((rows) => repair.enrich(rows, rpcClient, options, adapterOptions)),
      rebuild: deps.rebuild || ((rows, minute) => rebuildArchiveMinute(database, rows, minute)),
    };
    let processed = 0;
    while (await clock(BigInt(state.nextBlock)) < cutoff && (!options.maxRanges || processed < options.maxRanges)) {
      const cursor = BigInt(state.nextBlock);
      const minute = await clock(cursor) / 60n * 60n;
      const next = await minuteEnd(clock, cursor, end, minute + 60n, options.rangeSize);
      const rows = await minuteRows(rpcClient, cursor, next, options, pools);
      const result = await persistMinute(rows, options, context, new Date(Number(minute) * 1000).toISOString());
      await scope.assertAnchor('stock-quote', rpcClient, state);
      state = { ...state, nextBlock: next.toString(), minutes: state.minutes + 1,
        missing: state.missing + result.missing, updatedAt: new Date().toISOString() };
      context.state = state;
      await checkpoint.save(state);
      (deps.logger || console).log(JSON.stringify({ event: 'stock_minute_replay_progress', ...state, ...result }));
      processed += 1;
      if (options.sleepMs) await delay(options.sleepMs);
    }
    return { ...state, complete: await clock(BigInt(state.nextBlock)) >= cutoff,
      excludedEndMinute: new Date(Number(cutoff) * 1000).toISOString() };
  });
}

module.exports = { runStockMinuteReplay, __private: { blockClock, firstBlockAt, minuteEnd, restore } };
