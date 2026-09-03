const config = require('../../config');
const db = require('../models/db');
const { createLiquidityTimedDatabase } = require('./robinhood-liquidity-db-timing');
const {
  createRobinhoodPoolLiquiditySnapshotRepository,
} = require('../models/robinhood-pool-liquidity-snapshot');
const {
  createRobinhoodPoolLiquidityEventCursorRepository,
} = require('../models/robinhood-pool-liquidity-event-cursor');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createWorkerLeaseManager } = require('../services/worker-lease-manager');
const { createErc20MetadataReader } = require('../services/evm-erc20-metadata');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');
const {
  createRobinhoodPoolLiquidityOnchainReader,
} = require('../services/robinhood-pool-liquidity-onchain');
const {
  createRobinhoodPoolLiquidityWorker,
} = require('../services/robinhood-pool-liquidity-worker');
const { createRobinhoodWethUsdQuoteReader } = require('../services/robinhood-weth-usd-quote');

const LEASE_KEY = 'robinhood-pool-liquidity-worker';

async function main(deps = {}) {
  const options = deps.options || config.robinhoodPoolLiquidityWorker;
  if (!options.enabled) throw new Error('ROBINHOOD_POOL_LIQUIDITY_ENABLED must be true');
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(
    deps.rpcOptions || config.robinhoodIngestionWorker
  );
  const database = createLiquidityTimedDatabase(deps.database || db, {
    enabled: config.db.logSlowQueries, slowQueryMs: config.db.slowQueryLogMs,
  });
  const snapshotRepository = deps.snapshotRepository
    || createRobinhoodPoolLiquiditySnapshotRepository({ database });
  const cursorRepository = deps.cursorRepository
    || createRobinhoodPoolLiquidityEventCursorRepository({ database });
  const rangeRepository = deps.rangeRepository
    || createRobinhoodPersistenceRepository({ database });
  const reader = (deps.readerFactory || createRobinhoodPoolLiquidityOnchainReader)({
    rpcClient,
    metadataReader: (deps.metadataReaderFactory || createErc20MetadataReader)({ rpcClient }),
    quoteReader: (deps.quoteReaderFactory || createRobinhoodWethUsdQuoteReader)({ rpcClient }),
    v4RangeReader: rangeRepository,
  });
  const worker = await (deps.workerFactory || createRobinhoodPoolLiquidityWorker)({
    rpcClient, reader, snapshotRepository, cursorRepository,
  }, options);
  const leases = (deps.leaseManagerFactory || createWorkerLeaseManager)({
    heartbeatMs: options.leaseHeartbeatMs, ttlMs: options.leaseTtlMs,
  });
  let stopping = false;
  const keepAlive = setInterval(() => {}, 60_000);

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    await worker.stop();
    await leases.stop({ releaseLeases: true });
    await (deps.close || (() => db.pool.end()))();
  }

  leases.start({
    key: LEASE_KEY,
    label: 'Robinhood pool liquidity snapshots',
    metadata: { process: 'robinhood-pool-liquidity' },
    metadataProvider: worker.getStatus,
    start: async () => {
      await (deps.validateChainIds || validateRobinhoodProviderChainIds)(rpcClient);
      worker.start();
    },
  });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  return Object.freeze({ shutdown, worker, leases });
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodPoolLiquidityProcess] Fatal:', error.message);
  process.exitCode = 1;
  void db.pool.end();
});

module.exports = { LEASE_KEY, main };
