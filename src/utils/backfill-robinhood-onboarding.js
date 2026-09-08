require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createBlockTimestampEnricher } = require('../services/evm-log-enrichment');
const {
  CANONICAL_CONTRACTS, ROBINHOOD_TOKENIZED_ASSETS,
} = require('../services/robinhood-market-policy');
const v2 = require('../services/uniswap-v2-decoder');
const v3 = require('../services/uniswap-v3-decoder');
const v4 = require('../services/uniswap-v4-decoder');
const holderRecovery = require('./recover-robinhood-holder-deployments');
const { runGlobalHolderDelta } = require('./create-robinhood-holder-global-delta');
const globalWorker = require('../services/robinhood-holder-global-backfill-worker');
const { fetchLogs } = require('./audit-robinhood-v3-stock-pairs').__private;

const CHAIN_ID = 4663n;
const STOCK_CHECKPOINT_VERSION = 1;
const CONFIRM_FLAG = '--confirm-robinhood-onboarding-backfill';
const STOCKS = new Set(Object.values(ROBINHOOD_TOKENIZED_ASSETS).map((value) => value.toLowerCase()));
const STANDARD_QUOTES = new Set([
  CANONICAL_CONTRACTS.WETH.toLowerCase(),
  CANONICAL_CONTRACTS.USDG.toLowerCase(),
  v4.NATIVE_CURRENCY,
]);
const PROTOCOLS = Object.freeze([
  {
    protocol: 'uniswap-v2', address: v2.ROBINHOOD_V2_FACTORY,
    topic: v2.TOPICS.pairCreated, decode: v2.decodePairCreated,
  },
  {
    protocol: 'uniswap-v3', address: v3.ROBINHOOD_V3_FACTORY,
    topic: v3.TOPICS.poolCreated, decode: v3.decodePoolCreated,
  },
  {
    protocol: 'uniswap-v4', address: v4.ROBINHOOD_V4_POOL_MANAGER,
    topic: v4.TOPICS.initialize, decode: v4.decodeInitialize,
  },
]);

function integer(value, fallback, min, max, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return resolved;
}

function block(value, fallback, label) {
  const resolved = String(value ?? fallback ?? '').trim();
  if (!/^\d+$/.test(resolved)) throw new Error(`${label} must be a block`);
  return resolved;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const values = {};
  for (const argument of argv) {
    if (argument === CONFIRM_FLAG) {
      values.confirm = true;
      continue;
    }
    const match = String(argument).match(/^--([^=]+)=(.+)$/);
    if (!match || values[match[1]] !== undefined) throw new Error(`invalid argument: ${argument}`);
    values[match[1]] = match[2];
  }
  return Object.freeze({
    confirm: values.confirm === true,
    rpcUrl: String(values['rpc-url'] || env.ROBINHOOD_ARCHIVE_RPC_URL || '').trim(),
    fromBlock: block(values['from-block'], '0', '--from-block'),
    toBlock: values['to-block'] == null ? null : block(values['to-block'], null, '--to-block'),
    rangeSize: integer(values['range-size'], 2_000_000, 1, 10_000_000, '--range-size'),
    minRangeSize: integer(values['min-range-size'], 1, 1, 100_000, '--min-range-size'),
    stockRpcConcurrency: integer(
      values['stock-rpc-concurrency'], 12, 1, 32, '--stock-rpc-concurrency'
    ),
    stockCheckpointFile: String(
      values['stock-checkpoint-file']
        || env.ROBINHOOD_ONBOARDING_STOCK_CHECKPOINT_FILE || ''
    ).trim() || null,
    holderLimit: integer(values['holder-limit'], 50_000, 1, 100_000, '--holder-limit'),
    holderConcurrency: integer(values['holder-concurrency'], 24, 1, 64, '--holder-concurrency'),
    globalTimeoutMs: integer(
      values['global-timeout-minutes'], 300, 1, 300, '--global-timeout-minutes'
    ) * 60_000,
    timeoutMs: integer(values['timeout-ms'], 30_000, 1000, 60_000, '--timeout-ms'),
  });
}

function createCheckpointStore(filename) {
  if (!filename) return Object.freeze({ load: async () => null, save: async () => {} });
  const resolved = path.resolve(filename);
  let writeTail = Promise.resolve();
  return Object.freeze({
    load: async () => {
      try {
        return JSON.parse(await fs.readFile(resolved, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`Cannot read stock checkpoint ${resolved}: ${error.message}`);
      }
    },
    save: async (value) => {
      const serialized = `${JSON.stringify(value, null, 2)}\n`;
      const operation = writeTail.then(async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        const temporary = `${resolved}.tmp-${process.pid}`;
        try {
          await fs.writeFile(temporary, serialized, { mode: 0o600 });
          await fs.rename(temporary, resolved);
        } finally {
          await fs.unlink(temporary).catch((error) => {
            if (error?.code !== 'ENOENT') throw error;
          });
        }
      });
      writeTail = operation.catch(() => {});
      return operation;
    },
  });
}

function emptyProtocolProgress(fromBlock) {
  return {
    nextBlock: fromBlock, completed: false,
    scannedLogs: 0, stockPairs: 0, upsertedPools: 0, ranges: 0,
  };
}

function restoreCheckpoint(saved, options, toBlock) {
  if (!saved) {
    return {
      version: STOCK_CHECKPOINT_VERSION, chainId: CHAIN_ID.toString(),
      mode: options.confirm ? 'apply' : 'read-only',
      fromBlock: options.fromBlock, toBlock,
      protocols: Object.fromEntries(PROTOCOLS.map(({ protocol }) => (
        [protocol, emptyProtocolProgress(options.fromBlock)]
      ))),
    };
  }
  const expected = {
    version: STOCK_CHECKPOINT_VERSION, chainId: CHAIN_ID.toString(),
    mode: options.confirm ? 'apply' : 'read-only', fromBlock: options.fromBlock, toBlock,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(saved[key]) !== String(value)) {
      throw new Error(`Stock checkpoint ${key} does not match this execution`);
    }
  }
  for (const { protocol } of PROTOCOLS) {
    const progress = saved.protocols?.[protocol];
    if (!progress || !/^\d+$/.test(String(progress.nextBlock))) {
      throw new Error(`Stock checkpoint ${protocol} progress is invalid`);
    }
    const cursor = BigInt(progress.nextBlock);
    if (cursor < BigInt(options.fromBlock) || cursor > BigInt(toBlock) + 1n) {
      throw new Error(`Stock checkpoint ${protocol} cursor is outside the execution range`);
    }
  }
  return saved;
}

function isRpcPressureError(error) {
  return ['rate_limited', 'timeout', 'transport_error'].includes(error?.code)
    || (error?.code === 'http_error'
      && (error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500));
}

function createAdaptiveRpcLimiter(rpcClient, maximum) {
  let active = 0;
  let limit = maximum;
  let healthyRequests = 0;
  let reductions = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const task = queue.shift();
      active += 1;
      Promise.resolve().then(() => rpcClient.request(...task.args)).then((value) => {
        healthyRequests += 1;
        if (limit < maximum && healthyRequests >= limit * 8) {
          limit += 1;
          healthyRequests = 0;
        }
        task.resolve(value);
      }, (error) => {
        if (isRpcPressureError(error)) {
          limit = Math.max(1, Math.floor(limit / 2));
          healthyRequests = 0;
          reductions += 1;
        }
        task.reject(error);
      }).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return Object.freeze({
    request: (...args) => new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject });
      drain();
    }),
    getStatus: () => Object.freeze({ active, queued: queue.length, limit, maximum, reductions }),
  });
}

function assets(event) {
  return [event.token0 || event.currency0, event.token1 || event.currency1]
    .map((value) => String(value || '').toLowerCase());
}

function decodeStockPair(log, specification) {
  const initial = specification.decode(log);
  const [asset0, asset1] = assets(initial);
  const asset0Stock = STOCKS.has(asset0);
  const asset1Stock = STOCKS.has(asset1);
  if (asset0Stock === asset1Stock) return null;
  const stock = asset0Stock ? asset0 : asset1;
  const token = asset0Stock ? asset1 : asset0;
  if (STANDARD_QUOTES.has(token)) return null;
  const event = specification.decode(log, { quoteAddresses: [stock] });
  if (!event.tracked || event.tokenAddress !== token || event.quoteAddress !== stock) {
    throw new Error(`invalid ${specification.protocol} stock-pair orientation`);
  }
  return event;
}

function createRuntime(options, deps = {}) {
  if (!options.rpcUrl && !deps.rpcClient) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  const rpcClient = deps.rpcClient || createEvmJsonRpcClient({
    providers: [{ name: 'robinhood-onboarding-archive', url: options.rpcUrl }],
    timeoutMs: options.timeoutMs,
    maxRetries: 1,
  });
  return Object.freeze({
    rpcClient,
    timestamps: deps.timestamps || createBlockTimestampEnricher({
      rpcClient, concurrency: 24, batchSize: 100, batchConcurrency: 2,
    }),
    persistence: deps.persistence || createRobinhoodPersistenceRepository({
      database: deps.database || db,
    }),
  });
}

async function scanProtocol(options, runtime, specification, toBlock, logger, control = {}) {
  const restored = control.progress || emptyProtocolProgress(options.fromBlock);
  let cursor = BigInt(restored.nextBlock);
  const end = BigInt(toBlock);
  const initialCursor = cursor;
  const startedAt = Date.now();
  const totals = {
    scannedLogs: Number(restored.scannedLogs) || 0,
    stockPairs: Number(restored.stockPairs) || 0,
    upsertedPools: Number(restored.upsertedPools) || 0,
    ranges: Number(restored.ranges) || 0,
  };
  while (cursor <= end) {
    const requestedEnd = cursor + BigInt(options.rangeSize) - 1n;
    const rangeEnd = requestedEnd < end ? requestedEnd : end;
    const leaves = await fetchLogs(runtime.rpcClient, {
      address: specification.address,
      topics: [specification.topic],
    }, cursor, rangeEnd, options.minRangeSize, { parallelSplits: true });
    const logs = leaves.flat().filter((log) => log?.removed !== true);
    totals.scannedLogs += logs.length;
    const candidates = logs.filter((log) => decodeStockPair(log, specification) != null);
    const enriched = await runtime.timestamps.enrich(candidates);
    const events = enriched.map((log) => decodeStockPair(log, specification));
    totals.stockPairs += events.length;
    if (options.confirm && events.length) {
      const result = await runtime.persistence.upsertRecoveredPools(events);
      totals.upsertedPools += result.upsertedPools;
    }
    totals.ranges += 1;
    cursor = rangeEnd + 1n;
    await control.save?.(cursor.toString(), totals);
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const blocksPerSecond = Number(cursor - initialCursor) / elapsedSeconds;
    logger.log(JSON.stringify({
      event: 'robinhood_stock_pair_backfill_progress',
      protocol: specification.protocol,
      nextBlock: cursor.toString(),
      toBlock,
      progressPct: Number((((cursor - BigInt(options.fromBlock)) * 10_000n)
        / (end - BigInt(options.fromBlock) + 1n))) / 100,
      blocksPerSecond: Number(blocksPerSecond.toFixed(1)),
      etaSeconds: blocksPerSecond > 0
        ? Math.ceil(Number(end - cursor + 1n) / blocksPerSecond) : null,
      rpc: control.rpcStatus?.() || null,
      ...totals,
    }));
  }
  return totals;
}

async function backfillStockPairs(options, deps = {}) {
  const runtime = deps.runtime || createRuntime(options, deps);
  const logger = deps.logger || console;
  if (BigInt(await runtime.rpcClient.request('eth_chainId')) !== CHAIN_ID) {
    throw new Error('archive RPC is not Robinhood Chain');
  }
  const checkpoint = deps.stockCheckpoint || createCheckpointStore(options.stockCheckpointFile);
  const saved = await checkpoint.load();
  const toBlock = options.toBlock ?? saved?.toBlock
    ?? BigInt(await runtime.rpcClient.request('eth_blockNumber')).toString();
  if (BigInt(toBlock) < BigInt(options.fromBlock)) {
    throw new Error('--to-block must not precede --from-block');
  }
  const state = restoreCheckpoint(saved, options, toBlock);
  const limitedRpc = deps.stockRpcLimiter
    || createAdaptiveRpcLimiter(runtime.rpcClient, options.stockRpcConcurrency || 12);
  const scanRuntime = { ...runtime, rpcClient: limitedRpc };
  const protocols = Object.fromEntries(await Promise.all(PROTOCOLS.map(async (specification) => {
    const save = async (nextBlock, totals) => {
      state.protocols[specification.protocol] = {
        nextBlock, completed: BigInt(nextBlock) > BigInt(toBlock), ...totals,
      };
      state.updatedAt = new Date().toISOString();
      await checkpoint.save(state);
    };
    return [
      specification.protocol,
      await scanProtocol(options, scanRuntime, specification, toBlock, logger, {
        progress: state.protocols[specification.protocol], save,
        rpcStatus: limitedRpc.getStatus,
      }),
    ];
  })));
  return {
    mode: options.confirm ? 'apply' : 'read-only',
    fromBlock: options.fromBlock,
    toBlock,
    stockPairs: Object.values(protocols).reduce((sum, value) => sum + value.stockPairs, 0),
    upsertedPools: Object.values(protocols).reduce((sum, value) => sum + value.upsertedPools, 0),
    protocols,
  };
}

function globalOptions(options, catalogCutoff) {
  return globalWorker.__private.normalizeOptions({
    enabled: true,
    autoStart: true,
    rollingEnabled: false,
    catalogCutoff,
    intervalMs: 250,
    rangeSize: 5000,
    prefetch: 16,
    addressFilterLimit: 1000,
    maxCommitMs: 5000,
    addressShardConcurrency: 1,
    finalityBlocks: 2000,
    attachWindow: 19_999,
    materializeBatchSize: 5000,
  });
}

async function driveGlobalRun(
  runtime, workerOptions, options, logger, now = Date.now,
  campaignTick = globalWorker.__private.runCampaignTick
) {
  const deadline = now() + options.globalTimeoutMs;
  let lastLoggedAt = 0;
  let lastPhase = null;
  while (true) {
    const result = await campaignTick(runtime, workerOptions);
    const run = await runtime.lifecycle.getLatestRun();
    if (!run || run.status === 'completed') return result;
    if (run.status === 'paused') throw new Error('global holder backfill is paused');
    const currentTime = now();
    if (run.status !== lastPhase || currentTime - lastLoggedAt >= 30_000) {
      logger.log(JSON.stringify({
        event: 'robinhood_holder_global_backfill_progress',
        runId: String(run.id),
        phase: run.status,
        nextBlock: run.nextBlock,
        barrierBlock: run.barrierBlock,
        telemetry: result?.telemetry || null,
      }));
      lastPhase = run.status;
      lastLoggedAt = currentTime;
    }
    if (currentTime >= deadline) {
      const error = new Error('global holder backfill exceeded its resumable time limit');
      error.code = 'holder_global_backfill_deadline_exceeded';
      throw error;
    }
  }
}

async function runGlobalHolderBackfill(options, deps = {}) {
  const database = deps.database || db;
  const logger = deps.logger || console;
  const delta = deps.globalDelta || runGlobalHolderDelta;
  const catalogCutoff = deps.catalogCutoff || new Date().toISOString();
  const candidateInput = {
    database,
    catalogCutoff,
    includeUnseeded: true,
    includeBackfilling: false,
  };
  const preview = await delta(candidateInput);
  if (!options.confirm) return { mode: 'dry-run', preview };
  if (preview.incrementalBackfillActive) {
    const error = new Error('stop robinhood-holder-backfill-worker before applying');
    error.code = 'holder_global_delta_incremental_active';
    throw error;
  }
  const workerOptions = globalOptions(options, catalogCutoff);
  const runtime = deps.globalRuntime || await globalWorker.__private.buildRuntime(workerOptions, {
    database,
    env: {
      ...process.env,
      ROBINHOOD_HOLDER_GLOBAL_BACKFILL_RPC_URL: options.rpcUrl,
    },
  });
  let existing = await runtime.lifecycle.getLatestRun();
  if (existing && existing.status !== 'completed') {
    await driveGlobalRun(runtime, workerOptions, options, logger, deps.now, deps.campaignTick);
  }
  const refreshed = await delta(candidateInput);
  if (!refreshed.preview?.candidateTokens) {
    return { mode: 'apply', resumedRun: existing?.id == null ? null : String(existing.id), created: null };
  }
  const created = await delta({ ...candidateInput, confirm: true });
  const completed = await driveGlobalRun(
    runtime, workerOptions, options, logger, deps.now, deps.campaignTick
  );
  existing = await runtime.lifecycle.getLatestRun();
  return {
    mode: 'apply',
    resumedRun: null,
    created: created.created,
    completed,
    runId: existing?.id == null ? null : String(existing.id),
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv, deps.env);
  const logger = deps.logger || console;
  const globalPreview = await (deps.globalHolderMain || runGlobalHolderBackfill)(
    { ...options, confirm: false }, deps
  );
  if (options.confirm && globalPreview.preview?.incrementalBackfillActive) {
    const error = new Error('stop robinhood-holder-backfill-worker before applying');
    error.code = 'holder_global_delta_incremental_active';
    throw error;
  }
  const stockPairs = await backfillStockPairs(options, deps);
  const holders = await (deps.holderMain || holderRecovery.main)([], {
    options: {
      confirm: options.confirm,
      limit: options.holderLimit,
      concurrency: options.holderConcurrency,
      timeoutMs: options.timeoutMs,
    },
    logger,
    ...(deps.holderDeps || {}),
  });
  const holderLedger = options.confirm
    ? await (deps.globalHolderMain || runGlobalHolderBackfill)(options, deps)
    : globalPreview;
  const report = {
    mode: options.confirm ? 'apply' : 'read-only',
    stockPairs,
    holders,
    holderLedger,
  };
  logger.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood onboarding backfill failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  CONFIRM_FLAG, backfillStockPairs, decodeStockPair, main, parseArgs,
  runGlobalHolderBackfill,
  __private: {
    createAdaptiveRpcLimiter, createCheckpointStore, createRuntime, driveGlobalRun,
    globalOptions, restoreCheckpoint, scanProtocol,
  },
};
