const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createRobinhoodHeadProcessingRepository } = require('../models/robinhood-head-processing');
const { createRobinhoodWalletSwapCursorRepository } = require('../models/robinhood-wallet-swap-cursor');
const { createRobinhoodWalletSwapRepository } = require('../models/robinhood-wallet-swap-persistence');
const { createRobinhoodWalletSwapSourceReader } = require('../models/robinhood-wallet-swap-source-reader');
const { createRobinhoodWalletSwapAttributor } = require('./robinhood-wallet-swap-attributor');
const {
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('./robinhood-ingestion-worker');
const { runLiveTick } = require('./robinhood-wallet-swap-live-runner');
const marketTradeRealtime = require('./market-trade-realtime');

const FATAL_CODES = new Set(['configuration_error', 'persistent_reorg', 'source_contract_error']);

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled === true,
    intervalMs: boundedInteger(options.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(options.maxErrorBackoffMs, 30_000, 1000, 300_000),
    maxBlocks: boundedInteger(options.maxBlocks, 200, 1, 2000),
    reorgDepth: boundedInteger(options.reorgDepth, 12, 1, 1000),
    maxConsecutiveFailures: boundedInteger(options.maxConsecutiveFailures, 5, 1, 100),
    rpcOptions: options.rpcOptions || {},
  };
}

function blockTag(value) {
  return `0x${BigInt(String(value)).toString(16)}`;
}

async function buildRuntime(options, deps = {}) {
  const client = (deps.clientFactory || createRobinhoodRpcClient)(options.rpcOptions);
  const providerChainIds = await (
    deps.validateChainIds || validateRobinhoodProviderChainIds
  )(client);
  const walletRepository = (deps.walletRepositoryFactory || createRobinhoodWalletSwapRepository)();
  const cursor = (deps.cursorFactory || createRobinhoodWalletSwapCursorRepository)();
  const reader = (deps.sourceReaderFactory || createRobinhoodWalletSwapSourceReader)();
  const marketRepository = (
    deps.marketRepositoryFactory || createRobinhoodPersistenceRepository
  )({ emitMarketBucketUpdate: () => false });
  const headProcessingRepository = (
    deps.headProcessingRepositoryFactory || createRobinhoodHeadProcessingRepository
  )();
  const fetchBlock = (number, fullTransactions) => client.request(
    'eth_getBlockByNumber', [blockTag(number), fullTransactions]
  );
  const attributor = (deps.attributorFactory || createRobinhoodWalletSwapAttributor)({
    repository: walletRepository,
    fetchBlock: (number) => fetchBlock(number, true),
    parserVersion: 'rh-wallet-live-1',
    onTradesPersisted: (rows) => (deps.marketTradeRealtime || marketTradeRealtime).publishRows(rows),
  });
  return {
    providerChainIds,
    runnerDeps: {
      cursor,
      reader,
      attributor,
      reorgDepth: options.reorgDepth,
      maxBlocks: options.maxBlocks,
      readNodeHead: () => client.request('eth_blockNumber'),
      // Post-cutover the isolated worker must bound itself by the strict
      // processing frontier (oldest non-terminal capture) rather than the
      // monolith's robinhood_ingestion_cursors 'market': that legacy cursor froze
      // at the cutover block and pinned the live cursor there forever. This mirrors
      // robinhood-processing's derived emit (resolveDerivedEmit) so both consumers
      // share one honest "how far observations are complete" watermark.
      loadMarketCursor: async () => {
        const active = await headProcessingRepository.getOldestActiveCapture('market');
        return marketRepository.resolveMarketFrontier(active?.blockNumber ?? null);
      },
      fetchBlockHeader: (number) => fetchBlock(number, false),
    },
  };
}

function publicError(error) {
  return error ? {
    code: error.code || 'wallet_live_error',
    message: String(error.message || error).slice(0, 500),
    at: new Date().toISOString(),
  } : null;
}

function compactResult(result) {
  if (!result) return null;
  const fields = [
    'status', 'nodeHead', 'nodeSafeHead', 'sourceSafeHead', 'processableThrough',
    'nextBlock', 'safeHead', 'checkpointBlock', 'processedBlocks', 'attributed',
    'inserted', 'unresolved', 'missing', 'failedBlock',
  ];
  return Object.fromEntries(fields.map((key) => [key, result[key] ?? null]));
}

function lagBlocks(result) {
  if (result?.processableThrough == null || result?.nextBlock == null) return null;
  const lag = BigInt(result.processableThrough) - BigInt(result.nextBlock) + 1n;
  return (lag > 0n ? lag : 0n).toString();
}

function createRobinhoodWalletSwapLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const tick = deps.runLiveTick || runLiveTick;
  const runtimeFactory = deps.runtimeFactory || ((options) => buildRuntime(options, deps));
  let options = normalizeOptions();
  let runtimePromise = null;
  let timer = null;
  let activeRunPromise = null;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    providerChainIds: null, lastResult: null, lagBlocks: null,
    batches: 0, processedBlocks: 0, attributed: 0, inserted: 0, duplicateInserts: 0,
    missing: 0, unresolved: 0, retries: 0, conflicts: 0,
    consecutiveErrors: 0, consecutiveBlocked: 0, blockedBlock: null,
    lastCompletedAt: null, lastError: null,
  };

  async function getRuntime() {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve(runtimeFactory(options)).catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  }

  async function halt(error) {
    running = false;
    status.running = false;
    status.halted = true;
    status.lastError = publicError(error);
    if (timer) cancelSchedule(timer);
    timer = null;
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodWalletSwapLiveWorker] Fatal propagation failed:', fatalError.message);
    }
  }

  function recordResult(result) {
    status.lastResult = compactResult(result);
    status.lagBlocks = lagBlocks(result);
    status.batches += 1;
    for (const key of ['processedBlocks', 'attributed', 'inserted', 'missing', 'unresolved']) {
      status[key] += Number(result[key] || 0);
    }
    status.duplicateInserts += Math.max(0, Number(result.attributed || 0) - Number(result.inserted || 0));
    if (result.status === 'conflict') status.conflicts += 1;
    const blocked = result.status === 'blocked-unresolved';
    if (blocked) status.retries += 1;
    status.consecutiveBlocked = blocked && status.blockedBlock === result.failedBlock
      ? status.consecutiveBlocked + 1 : (blocked ? 1 : 0);
    status.blockedBlock = blocked ? result.failedBlock : null;
  }

  async function execute() {
    status.inFlight = true;
    try {
      const runtime = await getRuntime();
      status.providerChainIds = runtime.providerChainIds;
      const result = await tick(runtime.runnerDeps);
      recordResult(result);
      status.consecutiveErrors = 0;
      status.lastError = result.status === 'blocked-unresolved'
        ? publicError(Object.assign(
          new Error(`wallet attribution unresolved at block ${result.failedBlock}`),
          { code: 'wallet_attribution_unresolved' }
        ))
        : null;
      if (status.consecutiveBlocked >= options.maxConsecutiveFailures) {
        const error = new Error(`wallet attribution remained unresolved at block ${result.failedBlock}`);
        error.code = 'wallet_attribution_blocked';
        error.fatal = true;
        await halt(error);
      }
      return result;
    } catch (error) {
      status.consecutiveErrors += 1;
      status.retries += error.retryable === true ? 1 : 0;
      status.lastError = publicError(error);
      if (error.fatal === true || FATAL_CODES.has(error.code)) await halt(error);
      else logger.warn('[RobinhoodWalletSwapLiveWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date().toISOString();
    }
  }

  async function runOnce() {
    if (activeRunPromise) return activeRunPromise;
    activeRunPromise = execute().finally(() => { activeRunPromise = null; });
    return activeRunPromise;
  }

  function queueNext(delay) {
    if (!running || status.halted) return;
    timer = schedule(async () => {
      await runOnce();
      const failures = Math.max(status.consecutiveErrors, status.consecutiveBlocked);
      const backoff = Math.min(
        options.maxErrorBackoffMs,
        options.intervalMs * (2 ** Math.min(failures, 8))
      );
      queueNext(failures ? backoff : options.intervalMs);
    }, delay);
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    running = true;
    status.running = true;
    status.halted = false;
    queueNext(0);
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRunPromise) await activeRunPromise.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodWalletSwapLiveWorker();

module.exports = {
  createRobinhoodWalletSwapLiveWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { blockTag, buildRuntime, compactResult, lagBlocks, normalizeOptions },
};
