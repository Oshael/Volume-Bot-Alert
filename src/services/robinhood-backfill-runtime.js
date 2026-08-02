const os = require('os');
const {
  createRobinhoodPersistenceRepository,
} = require('../models/robinhood-persistence');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const {
  createRobinhoodBackfillEnrichmentAdapter,
} = require('./robinhood-backfill-enrichment-adapter');
const {
  createRobinhoodBackfillEnrichmentWorker,
} = require('./robinhood-backfill-enrichment-worker');
const {
  createRobinhoodBackfillFinalizer,
} = require('./robinhood-backfill-finalizer');
const {
  createRobinhoodBackfillWatchdog,
} = require('./robinhood-backfill-watchdog');
const {
  createRobinhoodBackfillAggregationWorker,
} = require('./robinhood-backfill-aggregation-worker');
const {
  createRobinhoodWethUsdQuoteReader,
} = require('./robinhood-weth-usd-quote');

const CHAIN_ID = 4663n;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function normalizeLoopOptions(input = {}) {
  return {
    enabled: input.enabled === true,
    intervalMs: boundedInteger(input.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(input.maxErrorBackoffMs, 30_000, 1000, 300_000),
  };
}

function createLoopRuntime(deps) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  let options = normalizeLoopOptions();
  let timer = null;
  let activeRun = null;
  let running = false;
  const status = {
    enabled: false,
    running: false,
    inFlight: false,
    consecutiveErrors: 0,
    totals: { runs: 0, errors: 0 },
    lastResult: null,
    lastError: null,
  };

  function runOnce() {
    if (activeRun) return activeRun;
    if (!options.enabled) return Promise.reject(new Error(`${deps.label} is disabled`));
    activeRun = (async () => {
      status.inFlight = true;
      status.totals.runs += 1;
      try {
        const result = await deps.execute(options);
        status.lastResult = result;
        status.lastError = null;
        status.consecutiveErrors = 0;
        return result;
      } catch (error) {
        status.totals.errors += 1;
        status.consecutiveErrors += 1;
        status.lastError = String(error?.message || error).slice(0, 500);
        throw error;
      } finally {
        status.inFlight = false;
        activeRun = null;
      }
    })();
    return activeRun;
  }

  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try {
        await runOnce();
      } catch (error) {
        logger.error(`[${deps.label}] ${error.message}`);
      } finally {
        if (running) {
          const exponent = Math.min(status.consecutiveErrors, 10);
          const delay = status.consecutiveErrors
            ? Math.min(options.maxErrorBackoffMs, options.intervalMs * (2 ** exponent))
            : options.intervalMs;
          queueNext(delay);
        }
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start(input = {}) {
    if (running) return false;
    options = deps.normalize(input);
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    deps.prepare?.(options);
    running = true;
    status.running = true;
    queueNext(0);
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => {});
  }

  return Object.freeze({
    getStatus: () => ({
      ...status,
      totals: { ...status.totals },
      ...(deps.telemetry?.() || {}),
    }),
    runOnce,
    start,
    stop,
  });
}

function normalizeEnrichmentOptions(input = {}) {
  const common = normalizeLoopOptions(input);
  const drpcRpcUrl = String(input.drpcRpcUrl || '').trim();
  const alchemyRpcUrl = String(input.alchemyRpcUrl || '').trim();
  if (common.enabled && !drpcRpcUrl) {
    throw new Error('ROBINHOOD_DRPC_RPC_URL is required for backfill enrichment');
  }
  if (common.enabled && input.alchemyTimestampsEnabled === true && !alchemyRpcUrl) {
    throw new Error('ROBINHOOD_ALCHEMY_RPC_URL is required for Alchemy timestamps');
  }
  const owner = String(input.owner || `${os.hostname()}:${process.pid}:enrichment`).trim();
  if (!owner || owner.length > 128) throw new Error('Backfill enrichment owner is invalid');
  return {
    ...common,
    drpcRpcUrl,
    alchemyRpcUrl,
    alchemyTimestampsEnabled: input.alchemyTimestampsEnabled === true,
    owner,
    leaseMs: boundedInteger(input.leaseMs, 60_000, 1000, 86_400_000),
    limit: boundedInteger(input.limit, 100, 1, 1000),
    retryDelayMs: boundedInteger(input.retryDelayMs, 5000, 0, 604_800_000),
    maxAttempts: boundedInteger(input.maxAttempts, 5, 1, 100),
    rpcBatchSize: boundedInteger(input.rpcBatchSize, 100, 1, 100),
    rpcConcurrency: boundedInteger(input.rpcConcurrency, 1, 1, 8),
    prepareConcurrency: boundedInteger(input.prepareConcurrency, 16, 1, 64),
    rpcTimeoutMs: boundedInteger(input.rpcTimeoutMs, 15_000, 1000, 60_000),
    rpcMaxRetries: boundedInteger(input.rpcMaxRetries, 1, 0, 5),
    rpcMinIntervalMs: boundedInteger(input.rpcMinIntervalMs, 0, 0, 60_000),
  };
}

function createEnrichmentRpcRouter(client, alchemyTimestampsEnabled) {
  const timestampProviders = ['alchemy-free', 'drpc'];
  const fallbackOptions = (options) => ({ ...options, fallbackOnRpcError: true });
  return Object.freeze({
    providers: alchemyTimestampsEnabled ? [...timestampProviders] : ['drpc'],
    getMetrics: () => client.getMetrics?.() || {},
    request: (method, params, options) => (
      client.requestProvider('drpc', method, params, options)
    ),
    requestBatch: (requests, options) => (
      client.requestBatchProvider('drpc', requests, options)
    ),
    requestProvider(provider, method, params, options) {
      if (provider !== 'alchemy-free' || !alchemyTimestampsEnabled) {
        return client.requestProvider(provider, method, params, options);
      }
      return client.requestProviders(
        timestampProviders, method, params, fallbackOptions(options)
      );
    },
    requestBatchProvider(provider, requests, options) {
      if (provider !== 'alchemy-free' || !alchemyTimestampsEnabled) {
        return client.requestBatchProvider(provider, requests, options);
      }
      return client.requestBatchProviders(
        timestampProviders, requests, fallbackOptions(options)
      );
    },
  });
}

function createRobinhoodBackfillEnrichmentRuntime(deps = {}) {
  let rawClient = null;
  let rpcClient = null;
  let repository = null;
  let quoteReader = null;
  let chainValidated = false;
  let timestampProvider = 'drpc';
  return createLoopRuntime({
    ...deps,
    label: 'RobinhoodBackfillEnrichment',
    normalize: normalizeEnrichmentOptions,
    prepare(options) {
      const providers = [{ name: 'drpc', url: options.drpcRpcUrl }];
      if (options.alchemyTimestampsEnabled) {
        providers.push({ name: 'alchemy-free', url: options.alchemyRpcUrl });
      }
      rawClient = (deps.clientFactory || createEvmJsonRpcClient)({
        providers,
        timeoutMs: options.rpcTimeoutMs,
        maxRetries: options.rpcMaxRetries,
        minRequestIntervalMs: options.rpcMinIntervalMs,
      });
      rpcClient = createEnrichmentRpcRouter(rawClient, options.alchemyTimestampsEnabled);
      quoteReader = (deps.quoteReaderFactory || createRobinhoodWethUsdQuoteReader)({
        rpcClient,
      });
      timestampProvider = options.alchemyTimestampsEnabled ? 'alchemy-free' : 'drpc';
      repository = (deps.repositoryFactory || createRobinhoodPersistenceRepository)();
      chainValidated = false;
    },
    async execute(options) {
      if (!chainValidated) {
        for (const provider of rawClient.providers) {
          const chainId = await rawClient.requestProvider(provider, 'eth_chainId');
          if (BigInt(chainId) !== CHAIN_ID) {
            throw new Error(`${provider} is not on Robinhood Chain`);
          }
        }
        chainValidated = true;
      }
      const seedPools = await repository.listActivePools();
      const adapter = (deps.adapterFactory || createRobinhoodBackfillEnrichmentAdapter)({
        seedPools,
        rpcClient,
        rpcProvider: 'drpc',
        timestampProvider,
        quoteReader,
        v4LiquidityReader: repository,
      });
      const worker = (deps.workerFactory || createRobinhoodBackfillEnrichmentWorker)({
        adapter,
        rpcClient,
        persistenceRepository: repository,
      });
      return worker.runOnce({
        owner: options.owner,
        leaseMs: options.leaseMs,
        limit: options.limit,
        retryDelayMs: options.retryDelayMs,
        maxAttempts: options.maxAttempts,
        providerBatchSizes: {
          drpc: options.rpcBatchSize,
          'alchemy-free': options.rpcBatchSize,
        },
        rpcConcurrency: options.rpcConcurrency,
        prepareConcurrency: options.prepareConcurrency,
      });
    },
    telemetry: () => ({
      timestampProvider,
      rpc: rawClient?.getMetrics?.() || {},
    }),
  });
}

function createRobinhoodBackfillFinalizerRuntime(deps = {}) {
  let finalizer = null;
  return createLoopRuntime({
    ...deps,
    label: 'RobinhoodBackfillFinalizer',
    normalize: (input) => ({
      ...normalizeLoopOptions(input),
      limit: boundedInteger(input.limit, 100, 1, 1000),
      statementTimeoutMs: boundedInteger(input.statementTimeoutMs, 15_000, 1000, 300_000),
      lockTimeoutMs: boundedInteger(input.lockTimeoutMs, 5000, 100, 60_000),
    }),
    prepare: () => {
      finalizer = (deps.finalizerFactory || createRobinhoodBackfillFinalizer)();
    },
    execute: (options) => finalizer.runOnce({
      limit: options.limit,
      statementTimeoutMs: options.statementTimeoutMs,
      lockTimeoutMs: options.lockTimeoutMs,
    }),
  });
}

function createRobinhoodBackfillWatchdogRuntime(deps = {}) {
  let watchdog = null;
  return createLoopRuntime({
    ...deps,
    label: 'RobinhoodBackfillWatchdog',
    normalize: (input) => ({
      ...normalizeLoopOptions(input),
      staleQueryThresholdMs: boundedInteger(
        input.staleQueryThresholdMs, 20_000, 5000, 300_000
      ),
    }),
    prepare: () => {
      watchdog = (deps.watchdogFactory || createRobinhoodBackfillWatchdog)();
    },
    execute: (options) => watchdog.runOnce({
      staleQueryThresholdMs: options.staleQueryThresholdMs,
    }),
  });
}

function createRobinhoodBackfillAggregationRuntime(deps = {}) {
  let worker = null;
  return createLoopRuntime({
    ...deps,
    label: 'RobinhoodBackfillAggregation',
    normalize: (input) => ({
      ...normalizeLoopOptions(input),
      owner: input.owner,
      claimLimit: boundedInteger(input.claimLimit, 10_000, 1, 100_000),
      leaseMs: boundedInteger(input.leaseMs, 900_000, 10_000, 86_400_000),
      retryDelayMs: boundedInteger(input.retryDelayMs, 5000, 0, 604_800_000),
      maxAttempts: boundedInteger(input.maxAttempts, 5, 1, 100),
      tokenLimit: boundedInteger(input.tokenLimit, 25, 1, 1000),
    }),
    prepare: () => {
      worker = (deps.workerFactory || createRobinhoodBackfillAggregationWorker)();
    },
    execute: (options) => worker.runOnce(options),
  });
}

const enrichment = createRobinhoodBackfillEnrichmentRuntime();
const finalizer = createRobinhoodBackfillFinalizerRuntime();
const watchdog = createRobinhoodBackfillWatchdogRuntime();
const aggregation = createRobinhoodBackfillAggregationRuntime();

module.exports = {
  aggregation,
  enrichment,
  finalizer,
  watchdog,
  createRobinhoodBackfillAggregationRuntime,
  createRobinhoodBackfillEnrichmentRuntime,
  createRobinhoodBackfillFinalizerRuntime,
  createRobinhoodBackfillWatchdogRuntime,
  __private: {
    createEnrichmentRpcRouter,
    normalizeEnrichmentOptions,
    normalizeLoopOptions,
  },
};
