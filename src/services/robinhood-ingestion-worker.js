const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { createRobinhoodContinuousRunner } = require('./robinhood-continuous-runner');
const { createRobinhoodSocialMetadataQueue } = require('./robinhood-social-metadata-queue');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');

const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const ROBINHOOD_CHAIN_ID = 4663n;
const FATAL_ERROR_CODES = new Set(['bootstrap_start_required', 'configuration_error', 'persistent_reorg']);

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled === true,
    publicRpcUrl: String(options.publicRpcUrl || PUBLIC_RPC_URL),
    alchemyRpcUrl: String(options.alchemyRpcUrl || ''),
    useAlchemy: options.useAlchemy === true,
    socialMetadataEnabled: options.socialMetadataEnabled === true,
    pollIntervalMs: boundedInteger(options.pollIntervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(options.maxErrorBackoffMs, 30_000, 1000, 300_000),
    rpcTimeoutMs: boundedInteger(options.rpcTimeoutMs, 15_000, 1000, 60_000),
    rpcMaxRetries: boundedInteger(options.rpcMaxRetries, 1, 0, 5),
    rpcMinIntervalMs: boundedInteger(options.rpcMinIntervalMs, 250, 0, 60_000),
    lookbackBlocks: boundedInteger(options.lookbackBlocks, 250, 1, 100_000),
    startBlock: options.startBlock || null,
    confirmations: boundedInteger(options.confirmations, 2, 0, 1000),
    rangeSize: boundedInteger(options.rangeSize, 10, 1, 1000),
    minRangeSize: boundedInteger(options.minRangeSize, 1, 1, 1000),
    maxRangeSize: boundedInteger(options.maxRangeSize, 100, 1, 10_000),
    maxRangesPerPoll: boundedInteger(options.maxRangesPerPoll, 20, 1, 1000),
    maxAddressesPerLogRequest: boundedInteger(options.maxAddressesPerLogRequest, 100, 1, 1000),
    marketLogFilterMode: options.marketLogFilterMode === 'tracked-addresses'
      ? 'tracked-addresses'
      : 'topics-only',
    timestampConcurrency: boundedInteger(options.timestampConcurrency, 16, 1, 32),
    observationConcurrency: boundedInteger(options.observationConcurrency, 1, 1, 16),
  };
}

function createClient(options) {
  const providers = [{ name: 'robinhood-public', url: options.publicRpcUrl }];
  if (options.useAlchemy && !options.alchemyRpcUrl) {
    const error = new TypeError('ROBINHOOD_ALCHEMY_RPC_URL is required when Alchemy fallback is enabled');
    error.code = 'configuration_error';
    throw error;
  }
  if (options.useAlchemy) {
    providers.push({ name: 'alchemy-free', url: options.alchemyRpcUrl });
  }
  return createEvmJsonRpcClient({
    providers,
    timeoutMs: options.rpcTimeoutMs,
    maxRetries: options.rpcMaxRetries,
    minRequestIntervalMs: options.rpcMinIntervalMs,
  });
}

function parseChainId(value, providerName) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    const error = new Error(`Robinhood RPC provider ${providerName} returned an invalid chain ID`);
    error.code = 'configuration_error';
    throw error;
  }
  return BigInt(raw);
}

async function validateProviderChainIds(client) {
  if (!Array.isArray(client?.providers) || typeof client.requestProvider !== 'function') {
    const error = new Error('Robinhood RPC client must support provider-specific chain validation');
    error.code = 'configuration_error';
    throw error;
  }
  const validated = {};
  for (const providerName of client.providers) {
    const chainId = parseChainId(
      await client.requestProvider(providerName, 'eth_chainId'),
      providerName
    );
    if (chainId !== ROBINHOOD_CHAIN_ID) {
      const error = new Error(
        `Robinhood RPC provider ${providerName} is on chain ${chainId}; expected ${ROBINHOOD_CHAIN_ID}`
      );
      error.code = 'configuration_error';
      throw error;
    }
    validated[providerName] = chainId.toString();
  }
  return validated;
}

function compactSnapshot(snapshot) {
  return snapshot ? {
    mode: snapshot.mode,
    marketLogFilterMode: snapshot.marketLogFilterMode || null,
    coverage: snapshot.coverage,
    tracked: snapshot.pipeline?.tracked || null,
    noxa: snapshot.pipeline?.metrics?.noxa || null,
    enrichment: snapshot.pipeline?.enrichment || null,
    inMemoryState: snapshot.pipeline?.inMemoryState || null,
    runner: snapshot.runner,
    rpc: snapshot.rpc,
  } : null;
}

function createRobinhoodIngestionWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  let options = normalizeOptions();
  let runner = null;
  let timer = null;
  let activeRunPromise = null;
  let running = false;
  let onFatal = null;
  let emitMarketBucketUpdate = null;
  let standardAlertSignalConsumer = null;
  const status = {
    enabled: false,
    running: false,
    inFlight: false,
    halted: false,
    lastRunAt: null,
    lastCompletedAt: null,
    lastSnapshot: null,
    consecutiveErrors: 0,
    totalErrors: 0,
    lastError: null,
    fatalPropagationError: null,
    providerChainIds: {},
  };

  async function buildRunner() {
    const rpcClient = (deps.clientFactory || createClient)(options);
    status.providerChainIds = await validateProviderChainIds(rpcClient);
    const repositoryFactory = deps.repositoryFactory || createRobinhoodPersistenceRepository;
    const repository = repositoryFactory({
      ...(emitMarketBucketUpdate ? { emitMarketBucketUpdate } : {}),
      ...(standardAlertSignalConsumer ? { standardAlertSignalConsumer } : {}),
    });
    const socialMetadataQueue = options.socialMetadataEnabled
      ? (deps.socialMetadataQueueFactory || createRobinhoodSocialMetadataQueue)()
      : null;
    return (deps.runnerFactory || createRobinhoodContinuousRunner)({
      rpcClient,
      repository,
      requireExplicitBootstrap: true,
      socialMetadataQueue,
      startBlock: options.startBlock,
      lookbackBlocks: options.lookbackBlocks,
      confirmations: options.confirmations,
      rangeSize: options.rangeSize,
      minRangeSize: options.minRangeSize,
      maxRangeSize: options.maxRangeSize,
      maxRangesPerPoll: options.maxRangesPerPoll,
      maxAddressesPerLogRequest: options.maxAddressesPerLogRequest,
      marketLogFilterMode: options.marketLogFilterMode,
      timestampConcurrency: options.timestampConcurrency,
      observationConcurrency: options.observationConcurrency,
    });
  }

  async function runOnce() {
    if (activeRunPromise) return activeRunPromise;
    activeRunPromise = (async () => {
      status.inFlight = true;
      status.lastRunAt = new Date().toISOString();
      try {
        runner ||= await buildRunner();
        const snapshot = await runner.pollOnce();
        status.lastSnapshot = compactSnapshot(snapshot);
        status.lastCompletedAt = new Date().toISOString();
        status.consecutiveErrors = 0;
        status.lastError = null;
        return snapshot;
      } catch (error) {
        status.totalErrors += 1;
        status.consecutiveErrors += 1;
        status.lastError = {
          code: error.code || error.name || 'error',
          message: String(error.message || error).slice(0, 500),
        };
        if (FATAL_ERROR_CODES.has(error.code)) {
          status.halted = true;
          running = false;
          status.running = false;
          try {
            await onFatal?.(error, { ...status });
          } catch (propagationError) {
            status.fatalPropagationError = String(
              propagationError?.message || propagationError
            ).slice(0, 500);
          }
        }
        throw error;
      } finally {
        status.inFlight = false;
        activeRunPromise = null;
      }
    })();
    return activeRunPromise;
  }

  function nextDelayMs() {
    if (!status.consecutiveErrors) return options.pollIntervalMs;
    return Math.min(
      options.maxErrorBackoffMs,
      options.pollIntervalMs * (2 ** Math.min(status.consecutiveErrors, 8))
    );
  }

  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try {
        await runOnce();
      } catch (error) {
        logger.error(`[RobinhoodIngestionWorker] ${error.code || 'error'}: ${error.message}`);
      } finally {
        queueNext(nextDelayMs());
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    emitMarketBucketUpdate = typeof input.emitMarketBucketUpdate === 'function'
      ? input.emitMarketBucketUpdate : null;
    standardAlertSignalConsumer = typeof input.standardAlertSignalConsumer === 'function'
      ? input.standardAlertSignalConsumer : null;
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    running = true;
    status.running = true;
    status.halted = false;
    status.fatalPropagationError = null;
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

const worker = createRobinhoodIngestionWorker();

module.exports = {
  PUBLIC_RPC_URL,
  ROBINHOOD_CHAIN_ID,
  createRobinhoodRpcClient: createClient,
  createRobinhoodIngestionWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  validateRobinhoodProviderChainIds: validateProviderChainIds,
  __private: { compactSnapshot, createClient, normalizeOptions, parseChainId, validateProviderChainIds },
};
