const robinhoodCatalog = require('../models/robinhood-catalog');
const { createErc20MetadataReader } = require('./evm-erc20-metadata');
const {
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('./robinhood-ingestion-worker');
const {
  createRobinhoodCatalogMetadataStore,
} = require('./robinhood-catalog-metadata-store');
const {
  createRobinhoodCatalogProjectionBatch,
} = require('./robinhood-catalog-projection-batch');
const { createRobinhoodSocialMetadataQueue } = require('./robinhood-social-metadata-queue');
const {
  createRobinhoodBlockscoutMetadataClient,
} = require('./robinhood-blockscout-metadata');

const DEFAULT_INTERVAL_MS = 60_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled === true,
    intervalMs: boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 60_000, 60 * 60_000),
    maxErrorBackoffMs: boundedInteger(
      options.maxErrorBackoffMs, 5 * 60_000, 60_000, 60 * 60_000,
    ),
    maxTokens: boundedInteger(options.maxTokens, 25, 1, 25),
    concurrency: boundedInteger(options.concurrency, 4, 1, 10),
    statementTimeoutMs: boundedInteger(options.statementTimeoutMs, 10_000, 1000, 60_000),
    blockscoutBatchSize: boundedInteger(options.blockscoutBatchSize, 10, 1, 50),
    socialMetadataEnabled: options.socialMetadataEnabled === true,
    socialBatchSize: boundedInteger(options.socialBatchSize, 5, 1, 5),
    socialDrainIntervalMs: boundedInteger(
      options.socialDrainIntervalMs, 60_000, 60_000, 60 * 60_000,
    ),
    socialDrainLimit: boundedInteger(options.socialDrainLimit, 1, 1, 10),
    rpcOptions: options.rpcOptions || options,
  };
}

function numericCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildRobinhoodCatalogProjectionTelemetry(workerStatus = {}, now = Date.now) {
  const summary = workerStatus.lastSummary || null;
  return Object.freeze({
    version: 1,
    capturedAt: new Date(now()).toISOString(),
    running: workerStatus.running === true,
    inFlight: workerStatus.inFlight === true,
    totalRuns: numericCount(workerStatus.totalRuns),
    totalErrors: numericCount(workerStatus.totalErrors),
    consecutiveErrors: numericCount(workerStatus.consecutiveErrors),
    lastRunAt: workerStatus.lastRunAt ?? null,
    lastCompletedAt: workerStatus.lastCompletedAt ?? null,
    lastError: workerStatus.lastError ?? null,
    lastSummary: summary ? {
      status: summary.status ?? null,
      candidates: numericCount(summary.candidates),
      projected: numericCount(summary.projected),
      projectionErrors: numericCount(summary.projectionErrors),
      onchainResolved: numericCount(summary.onchainResolved),
      onchainErrors: numericCount(summary.onchainErrors),
      blockscoutChecked: numericCount(summary.blockscoutChecked),
      blockscoutImagesResolved: numericCount(summary.blockscoutImagesResolved),
      blockscoutErrors: numericCount(summary.blockscoutErrors),
      excludedBlocked: numericCount(summary.excludedBlocked),
      socialEnqueued: numericCount(summary.socialEnqueued),
      // Deprecated compatibility field; projection batches no longer demote
      // catalog identities because activity becomes stale.
      demoted: numericCount(summary.demoted),
      candidateLimitReached: summary.candidateLimitReached === true,
    } : null,
  });
}

async function createDefaultBatch(options, deps) {
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(options.rpcOptions);
  await (deps.validateProviderChainIds || validateRobinhoodProviderChainIds)(rpcClient);
  const metadataReader = (deps.metadataReaderFactory || createErc20MetadataReader)({ rpcClient });
  const blockscoutReader = (
    deps.blockscoutReaderFactory || createRobinhoodBlockscoutMetadataClient
  )();
  let socialQueue = null;
  if (options.socialMetadataEnabled) {
    const store = (deps.metadataStoreFactory || createRobinhoodCatalogMetadataStore)({
      catalog: deps.catalog || robinhoodCatalog,
    });
    socialQueue = (deps.socialQueueFactory || createRobinhoodSocialMetadataQueue)({
      store,
      maxBatchSize: options.socialBatchSize,
      minDrainIntervalMs: options.socialDrainIntervalMs,
    });
  }
  return (deps.batchFactory || createRobinhoodCatalogProjectionBatch)({
    catalog: deps.catalog || robinhoodCatalog,
    metadataReader,
    blockscoutReader,
    socialQueue,
  });
}

function createRobinhoodCatalogProjectionWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  let options = normalizeOptions();
  let batch = deps.batch || null;
  let timer = null;
  let running = false;
  let activeRunPromise = null;
  const status = {
    enabled: false, running: false, inFlight: false,
    lastRunAt: null, lastCompletedAt: null, lastSummary: null,
    lastError: null, consecutiveErrors: 0, totalErrors: 0, totalRuns: 0,
  };

  async function runOnce() {
    if (activeRunPromise) return activeRunPromise;
    activeRunPromise = (async () => {
      status.inFlight = true;
      status.lastRunAt = new Date().toISOString();
      status.totalRuns += 1;
      try {
        batch ||= await createDefaultBatch(options, deps);
        const summary = await batch.runOnce({
          maxTokens: options.maxTokens,
          concurrency: options.concurrency,
          statementTimeoutMs: options.statementTimeoutMs,
          blockscoutBatchSize: options.blockscoutBatchSize,
          socialDrainLimit: options.socialDrainLimit,
        });
        status.lastSummary = summary;
        status.lastError = null;
        status.consecutiveErrors = 0;
        status.lastCompletedAt = new Date().toISOString();
        return summary;
      } catch (error) {
        status.totalErrors += 1;
        status.consecutiveErrors += 1;
        status.lastError = String(error?.message || error).slice(0, 500);
        throw error;
      } finally {
        status.inFlight = false;
        activeRunPromise = null;
      }
    })();
    return activeRunPromise;
  }

  function nextDelayMs() {
    if (!status.consecutiveErrors) return options.intervalMs;
    return Math.min(
      options.maxErrorBackoffMs,
      options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8)),
    );
  }

  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try {
        await runOnce();
      } catch (error) {
        logger.error(`[RobinhoodCatalogProjectionWorker] ${error.message}`);
      } finally {
        queueNext(nextDelayMs());
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    status.enabled = options.enabled;
    if (!options.enabled) return false;
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
    if (activeRunPromise) await activeRunPromise.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodCatalogProjectionWorker();

module.exports = {
  DEFAULT_INTERVAL_MS,
  buildRobinhoodCatalogProjectionTelemetry,
  createRobinhoodCatalogProjectionWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { createDefaultBatch, normalizeOptions },
};
