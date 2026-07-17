require('dotenv').config();

const db = require('../models/db');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const {
  createRobinhoodDiscoveryBootstrapRunner,
} = require('../services/robinhood-continuous-runner');
const {
  PUBLIC_RPC_URL,
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');

const PUBLIC_PROVIDER = 'robinhood-public';
const ALCHEMY_PROVIDER = 'alchemy-free';
const ALCHEMY_BOOTSTRAP_METHODS = new Set(['eth_blockNumber', 'eth_getBlockByNumber']);
const DEFAULT_ALCHEMY_MIN_INTERVAL_MS = 50;

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function optionalBlock(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error('ROBINHOOD_DISCOVERY_BOOTSTRAP_START_BLOCK must be decimal or hex');
  }
  return BigInt(raw).toString();
}

function createDiscoveryBootstrapRpcRouter(client, options = {}) {
  if (options.useAlchemy !== true) return client;
  const providers = Array.isArray(client?.providers) ? client.providers : [];
  if (
    typeof client?.requestProvider !== 'function'
    || !providers.includes(PUBLIC_PROVIDER)
    || !providers.includes(ALCHEMY_PROVIDER)
  ) {
    const error = new TypeError('Hybrid discovery bootstrap requires public and Alchemy providers');
    error.code = 'configuration_error';
    throw error;
  }

  const alchemyMinIntervalMs = integer(
    options.alchemyMinIntervalMs,
    DEFAULT_ALCHEMY_MIN_INTERVAL_MS,
    0,
    5000
  );
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now || Date.now;
  let nextAlchemyRequestAt = 0;
  let alchemySchedule = Promise.resolve();

  function scheduleAlchemyRequest(method, params, requestOptions) {
    const slot = alchemySchedule.then(async () => {
      const delayMs = Math.max(0, nextAlchemyRequestAt - now());
      if (delayMs > 0) await sleep(delayMs);
      nextAlchemyRequestAt = Math.max(nextAlchemyRequestAt, now()) + alchemyMinIntervalMs;
    });
    alchemySchedule = slot.catch(() => {});
    return slot.then(() => client.requestProvider(ALCHEMY_PROVIDER, method, params, requestOptions));
  }

  return Object.freeze({
    providers: [...providers],
    request(method, params = [], requestOptions = {}) {
      const provider = ALCHEMY_BOOTSTRAP_METHODS.has(method)
        ? ALCHEMY_PROVIDER
        : PUBLIC_PROVIDER;
      if (provider === ALCHEMY_PROVIDER) {
        return scheduleAlchemyRequest(method, params, requestOptions);
      }
      return client.requestProvider(provider, method, params, requestOptions);
    },
    requestProvider: client.requestProvider.bind(client),
    getMetrics: typeof client.getMetrics === 'function'
      ? client.getMetrics.bind(client)
      : () => ({}),
  });
}

function readOptions(env = process.env) {
  const rangeSize = integer(env.ROBINHOOD_DISCOVERY_BOOTSTRAP_RANGE_SIZE, 250, 1, 10_000);
  const defaultMaxRangeSize = Math.max(2000, rangeSize);
  return {
    startBlock: optionalBlock(env.ROBINHOOD_DISCOVERY_BOOTSTRAP_START_BLOCK),
    publicRpcUrl: String(env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL).trim(),
    alchemyRpcUrl: String(env.ROBINHOOD_ALCHEMY_RPC_URL || '').trim(),
    useAlchemy: String(env.ROBINHOOD_DISCOVERY_BOOTSTRAP_USE_ALCHEMY || '').toLowerCase() === 'true',
    alchemyMinIntervalMs: integer(
      env.ROBINHOOD_DISCOVERY_BOOTSTRAP_ALCHEMY_MIN_INTERVAL_MS,
      DEFAULT_ALCHEMY_MIN_INTERVAL_MS,
      0,
      5000
    ),
    rpcTimeoutMs: integer(env.ROBINHOOD_RPC_TIMEOUT_MS, 15_000, 1000, 60_000),
    rpcMaxRetries: integer(env.ROBINHOOD_RPC_MAX_RETRIES, 1, 0, 5),
    confirmations: integer(env.ROBINHOOD_CONFIRMATIONS, 2, 0, 1000),
    rangeSize,
    minRangeSize: integer(env.ROBINHOOD_DISCOVERY_BOOTSTRAP_MIN_RANGE_SIZE, 1, 1, rangeSize),
    maxRangeSize: integer(
      env.ROBINHOOD_DISCOVERY_BOOTSTRAP_MAX_RANGE_SIZE,
      defaultMaxRangeSize,
      rangeSize,
      100_000
    ),
    maxRangesPerPoll: integer(
      env.ROBINHOOD_DISCOVERY_BOOTSTRAP_MAX_RANGES,
      100,
      1,
      1000
    ),
  };
}

function compactReport(snapshot, providerChainIds) {
  return {
    mode: snapshot.mode,
    status: snapshot.status,
    providerChainIds,
    coverageStartBlock: snapshot.coverageStartBlock,
    targetBlock: snapshot.targetBlock,
    nextBlock: snapshot.poller.nextBlock,
    remainingBlocks: snapshot.remainingBlocks,
    rangeSize: snapshot.poller.rangeSize,
    ranges: snapshot.poller.metrics.ranges,
    blocksProcessed: snapshot.poller.metrics.blocksProcessed,
    logsReceived: snapshot.poller.metrics.logsReceived,
    logsAccepted: snapshot.poller.metrics.logsAccepted,
    rangeShrinks: snapshot.poller.metrics.rangeShrinks,
    rangeGrows: snapshot.poller.metrics.rangeGrows,
    tracked: snapshot.tracked,
    rpc: snapshot.rpc,
    historicalNoxaEnrichment: false,
    marketWriterEnabled: false,
    publishable: false,
  };
}

async function runDiscoveryBootstrap(options = readOptions(), dependencies = {}) {
  const client = dependencies.rpcClient || createRobinhoodRpcClient(options);
  const validateChainIds = dependencies.validateChainIds || validateRobinhoodProviderChainIds;
  const providerChainIds = await validateChainIds(client);
  const bootstrapClient = createDiscoveryBootstrapRpcRouter(client, options);
  const repository = dependencies.repository || createRobinhoodPersistenceRepository();
  const runner = await (dependencies.runnerFactory || createRobinhoodDiscoveryBootstrapRunner)({
    rpcClient: bootstrapClient,
    repository,
    startBlock: options.startBlock,
    confirmations: options.confirmations,
    rangeSize: options.rangeSize,
    minRangeSize: options.minRangeSize,
    maxRangeSize: options.maxRangeSize,
    maxRangesPerPoll: options.maxRangesPerPoll,
  });
  return compactReport(await runner.runBatch(), providerChainIds);
}

if (require.main === module) {
  runDiscoveryBootstrap().then((report) => {
    console.log(`[RobinhoodDiscoveryBootstrap] report=${JSON.stringify(report)}`);
  }).catch((error) => {
    console.error(`[RobinhoodDiscoveryBootstrap] fatal=${error.code || 'error'}:${error.message}`);
    process.exitCode = 1;
  }).finally(() => db.pool.end().catch(() => {}));
}

module.exports = {
  compactReport,
  createDiscoveryBootstrapRpcRouter,
  optionalBlock,
  readOptions,
  runDiscoveryBootstrap,
};
