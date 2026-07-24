const { createRobinhoodBackfillCaptureRepository } = require('../models/robinhood-backfill-capture');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { createRobinhoodDiscoveryBootstrapRunner } = require('./robinhood-continuous-runner');
const { parseQuantity } = require('./evm-log-poller');
const CHAIN_ID = 4663n;
const PROVIDERS = Object.freeze({
  public: { name: 'robinhood-public', urlKey: 'publicRpcUrl' },
  drpc: { name: 'drpc', urlKey: 'drpcRpcUrl' },
  alchemy: { name: 'alchemy-free', urlKey: 'alchemyRpcUrl' },
});
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}
function providerRole(value, fallback, label) {
  const role = String(value || fallback).trim().toLowerCase();
  if (!PROVIDERS[role]) throw new Error(`${label} must be public, drpc or alchemy`);
  return role;
}
function normalizeOptions(input = {}) {
  const scanProvider = providerRole(input.scanProvider, 'drpc', 'scanProvider');
  const rangeSize = boundedInteger(input.rangeSize, 10_000, 1, 10_000);
  if (scanProvider === 'alchemy' && rangeSize > 10) {
    throw new Error('Alchemy Free discovery ranges cannot exceed 10 blocks');
  }
  return {
    enabled: input.enabled === true,
    startBlock: input.startBlock == null || input.startBlock === '' ? null
      : parseQuantity(input.startBlock, 'startBlock').toString(),
    scanProvider,
    headProvider: providerRole(input.headProvider, 'public', 'headProvider'),
    publicRpcUrl: String(input.publicRpcUrl || 'https://rpc.mainnet.chain.robinhood.com').trim(),
    drpcRpcUrl: String(input.drpcRpcUrl || '').trim(),
    alchemyRpcUrl: String(input.alchemyRpcUrl || '').trim(),
    confirmations: boundedInteger(input.confirmations, 2, 0, 1000), rangeSize,
    minRangeSize: boundedInteger(input.minRangeSize, 10, 1, rangeSize),
    maxRangesPerPoll: boundedInteger(input.maxRangesPerPoll, 4, 1, 100),
    intervalMs: boundedInteger(input.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(input.maxErrorBackoffMs, 30_000, 1000, 300_000),
    rpcTimeoutMs: boundedInteger(input.rpcTimeoutMs, 15_000, 1000, 60_000),
    rpcMaxRetries: boundedInteger(input.rpcMaxRetries, 1, 0, 5),
    rpcMinIntervalMs: boundedInteger(input.rpcMinIntervalMs, 0, 0, 60_000),
    decoderVersion: String(input.decoderVersion || 'discovery-log-v1').trim(),
  };
}
function createClient(options, clientFactory = createEvmJsonRpcClient) {
  const roles = [...new Set([options.headProvider, options.scanProvider])];
  return clientFactory({
    providers: roles.map((role) => {
      const spec = PROVIDERS[role];
      const url = options[spec.urlKey];
      if (!url) throw new Error(`${spec.urlKey} is required for the ${role} provider`);
      return { name: spec.name, url, minRequestIntervalMs: options.rpcMinIntervalMs };
    }),
    timeoutMs: options.rpcTimeoutMs, maxRetries: options.rpcMaxRetries,
    minRequestIntervalMs: options.rpcMinIntervalMs,
  });
}
function watermarkCursor(watermark) {
  if (!watermark) return null;
  return {
    next_block: watermark.nextBlock, checkpoint_block: watermark.checkpointBlock,
    checkpoint_hash: watermark.checkpointHash,
    checkpoint_timestamp: watermark.checkpointTimestamp,
  };
}
function createRouter(client, options) {
  const scanProvider = PROVIDERS[options.scanProvider].name;
  const headProvider = PROVIDERS[options.headProvider].name;
  return Object.freeze({
    providers: [...new Set([headProvider, scanProvider])],
    getMetrics: () => client.getMetrics?.() || {},
    async request(method, params = [], requestOptions = {}) {
      const provider = method === 'eth_blockNumber' ? headProvider : scanProvider;
      try {
        return await client.requestProvider(provider, method, params, requestOptions);
      } catch (error) {
        if (method === 'eth_getLogs'
          && (error?.code === 'rate_limited' || error?.httpStatus === 429)) {
          error.code = 'discovery_provider_backpressure';
        }
        throw error;
      }
    },
  });
}
function createRobinhoodBackfillDiscoveryScanner(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  let options = normalizeOptions();
  let runner = null;
  let client = null;
  let activeRun = null;
  let timer = null;
  let running = false;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    scanProvider: 'drpc', headProvider: 'public', lastSnapshot: null,
    lastError: null, consecutiveErrors: 0, totalErrors: 0, rpc: {},
  };
  async function buildRunner() {
    client = (deps.clientFactory || createClient)(options);
    for (const role of new Set([options.headProvider, options.scanProvider])) {
      const provider = PROVIDERS[role].name;
      const chainId = parseQuantity(await client.requestProvider(
        provider, 'eth_chainId'
      ), `${provider}.chainId`);
      if (chainId !== CHAIN_ID) throw new Error(`${provider} is not Robinhood Chain`);
    }
    const capture = (deps.captureRepositoryFactory || createRobinhoodBackfillCaptureRepository)();
    const catalog = (deps.catalogRepositoryFactory || createRobinhoodPersistenceRepository)();
    const repository = {
      loadCursor: async () => watermarkCursor(await capture.loadDiscoveryScanWatermark()),
      listActivePools: () => catalog.listActivePools(),
      commitDiscoveryRange: ({ entries, cursor }) => catalog.commitDiscoveryRange({
        entries, cursor,
        backfillCapture: {
          provider: options.scanProvider, decoderVersion: options.decoderVersion,
          rawLogCount: cursor.logs.length,
        },
      }),
    };
    return (deps.runnerFactory || createRobinhoodDiscoveryBootstrapRunner)({
      rpcClient: createRouter(client, options),
      repository, startBlock: options.startBlock,
      confirmations: options.confirmations,
      rangeSize: options.rangeSize, minRangeSize: options.minRangeSize,
      maxRangeSize: options.rangeSize, maxRangesPerPoll: options.maxRangesPerPoll,
    });
  }
  function runOnce() {
    if (activeRun) return activeRun;
    if (!options.enabled) return Promise.reject(new Error('Robinhood discovery shadow is disabled'));
    activeRun = (async () => {
      status.inFlight = true;
      try {
        runner ||= await buildRunner();
        const snapshot = await runner.runBatch();
        status.lastSnapshot = snapshot;
        status.lastError = null;
        status.consecutiveErrors = 0;
        status.rpc = client.getMetrics?.() || {};
        return snapshot;
      } catch (error) {
        status.totalErrors += 1;
        status.consecutiveErrors += 1;
        status.lastError = { code: error.code || error.name || 'error',
          message: String(error.message || error).slice(0, 500) };
        if (error.code === 'persistent_reorg') {
          running = false;
          status.running = false;
          status.halted = true;
        }
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
      try { await runOnce(); } catch (error) {
        logger.error(`[RobinhoodBackfillDiscovery] ${error.message}`);
      } finally {
        if (running) {
          const delay = status.consecutiveErrors
            ? Math.min(options.maxErrorBackoffMs, options.intervalMs * (2 ** status.consecutiveErrors))
            : options.intervalMs;
          queueNext(delay);
        }
      }
    }, delayMs);
    timer?.unref?.();
  }
  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    Object.assign(status, { enabled: options.enabled, halted: false,
      scanProvider: options.scanProvider, headProvider: options.headProvider });
    if (!options.enabled) return false;
    runner = null;
    client = null;
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
    getStatus: () => ({ ...status, lastSnapshot: status.lastSnapshot && { ...status.lastSnapshot } }),
    runOnce, start, stop,
  });
}
const scanner = createRobinhoodBackfillDiscoveryScanner();
module.exports = {
  createRobinhoodBackfillDiscoveryScanner,
  getStatus: scanner.getStatus, runOnce: scanner.runOnce,
  start: scanner.start, stop: scanner.stop,
  __private: { createClient, createRouter, normalizeOptions, watermarkCursor },
};
