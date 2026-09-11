'use strict';

const config = require('../../config');
const db = require('../models/db');
const { createRobinhoodCanonicalLiquiditySource } = require('../models/robinhood-canonical-liquidity-source');
const {
  createRobinhoodPoolLiquidityEventCursorRepository,
} = require('../models/robinhood-pool-liquidity-event-cursor');
const {
  createRobinhoodPoolLiquidityRefreshQueue,
} = require('../models/robinhood-pool-liquidity-refresh-queue');
const {
  createRobinhoodPoolLiquiditySnapshotRepository,
} = require('../models/robinhood-pool-liquidity-snapshot');
const {
  createRobinhoodLiquidityRealtimeOutboxRepository,
} = require('../models/robinhood-liquidity-realtime-outbox');
const { createLiquidityHistoricalRangeRepository } = require('../models/robinhood-liquidity-historical-ranges');
const { createLiquidityTimedDatabase } = require('./robinhood-liquidity-db-timing');
const { createErc20MetadataReader } = require('../services/evm-erc20-metadata');
const {
  createRobinhoodCanonicalLiquidityRefresher,
} = require('../services/robinhood-canonical-liquidity-refresher');
const {
  createRobinhoodCanonicalLiquidityScanner,
} = require('../services/robinhood-canonical-liquidity-scanner');
const {
  createRobinhoodCanonicalLiquidityWorker,
} = require('../services/robinhood-canonical-liquidity-worker');
const { createRobinhoodDerivedRunner } = require('../services/robinhood-derived-runner');
const marketLiquidityRealtime = require('../services/market-liquidity-realtime');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');
const {
  createRobinhoodPoolLiquidityOnchainReader,
} = require('../services/robinhood-pool-liquidity-onchain');
const { createRobinhoodWethUsdQuoteReader } = require('../services/robinhood-weth-usd-quote');
const { createRobinhoodLiveRpcGuard } = require('../services/robinhood-live-rpc-guard');
const { createWorkerLeaseManager } = require('../services/worker-lease-manager');

const LEASE_KEY = 'robinhood-canonical-liquidity-worker';
const LEGACY_LEASE_KEY = 'robinhood-pool-liquidity-worker';
const CAPTURE_LEASE_KEY = 'robinhood-chain-capture-worker';
const HEAD_LEASE_KEY = 'robinhood-canonical-head-worker';

function liquidityRpcOptions(options, base = config.robinhoodIngestionWorker) {
  let parsed;
  try { parsed = new URL(String(options.rpcUrl || '')); } catch (_) { parsed = null; }
  const hostname = parsed?.hostname?.toLowerCase();
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    const error = new Error(
      'ROBINHOOD_CANONICAL_LIQUIDITY_RPC_URL must be an explicit loopback RPC URL'
    );
    error.code = 'configuration_error';
    throw error;
  }
  return { ...base, publicRpcUrl: parsed.toString(), useAlchemy: false, useDrpc: false,
    rpcTimeoutMs: options.rpcTimeoutMs, rpcMaxRetries: 0, rpcMinIntervalMs: 0 };
}

async function assertCanonicalReady(database, options = {}) {
  const schema = await database.query(
    `SELECT to_regclass('public.robinhood_pool_liquidity_refresh_queue') AS refresh_queue,
            to_regclass('public.robinhood_liquidity_realtime_outbox') AS realtime_outbox`
  );
  if (!schema.rows[0]?.refresh_queue) {
    const error = new Error('Stage 197 liquidity refresh queue must be installed');
    error.code = 'canonical_liquidity_schema_missing';
    throw error;
  }
  if (options.realtimePublisherEnabled && !schema.rows[0]?.realtime_outbox) {
    const error = new Error('Stage 212 liquidity realtime outbox must be installed');
    error.code = 'liquidity_realtime_schema_missing';
    throw error;
  }
  const result = await database.query(
    `SELECT lease_key, metadata FROM worker_leases
      WHERE lease_key=ANY($1::varchar[]) AND lease_until>NOW()`,
    [[LEGACY_LEASE_KEY, CAPTURE_LEASE_KEY, HEAD_LEASE_KEY]]
  );
  const active = new Map(result.rows.map((row) => [row.lease_key, row.metadata || {}]));
  if (active.has(LEGACY_LEASE_KEY)) {
    const error = new Error('legacy liquidity worker must be inactive');
    error.code = 'legacy_liquidity_still_active';
    throw error;
  }
  if (!active.has(CAPTURE_LEASE_KEY)) {
    const error = new Error('canonical chain capture must be active');
    error.code = 'canonical_capture_inactive';
    throw error;
  }
  if (active.get(HEAD_LEASE_KEY)?.mode !== 'canonical_publish') {
    const error = new Error('canonical head publisher must be active');
    error.code = 'canonical_head_publisher_inactive';
    throw error;
  }
}

function createRealtimePublisher(deps, options, database) {
  if (!options.realtimePublisherEnabled) return deps.publisher || null;
  if (deps.publisher) return deps.publisher;
  const outbox = deps.realtimeOutboxRepository
    || createRobinhoodLiquidityRealtimeOutboxRepository({ database });
  const runner = (deps.publisherRunnerFactory || createRobinhoodDerivedRunner)({
    repository: outbox, fanout: (deps.marketLiquidityRealtime || marketLiquidityRealtime).publish,
    options: {
      owner: `robinhood-liquidity-realtime:${process.pid}`,
      batchSize: options.realtimeBatchSize, leaseMs: options.realtimeLeaseMs,
      maxAttempts: options.realtimeMaxAttempts,
      baseBackoffMs: options.retryBaseMs, maxBackoffMs: options.retryMaxMs,
    },
  });
  return { runOnce: async () => ({
    ...await runner.runOnce(), backlog: await outbox.readBacklog(),
  }) };
}

function composeWorker(deps, options, rawDatabase, rpcClient) {
  const database = deps.timedDatabase || createLiquidityTimedDatabase(rawDatabase, {
    enabled: config.db.logSlowQueries, slowQueryMs: config.db.slowQueryLogMs,
  });
  const snapshotRepository = deps.snapshotRepository
    || createRobinhoodPoolLiquiditySnapshotRepository({
      database, canonicalAnchorOnly: true,
    });
  const cursorRepository = deps.cursorRepository
    || createRobinhoodPoolLiquidityEventCursorRepository({ database });
  const refreshQueue = deps.refreshQueue
    || createRobinhoodPoolLiquidityRefreshQueue({ database });
  const source = deps.source || createRobinhoodCanonicalLiquiditySource({ database });
  const rangeRepository = deps.rangeRepository
    || createLiquidityHistoricalRangeRepository({ database });
  const reader = deps.reader || createRobinhoodPoolLiquidityOnchainReader({
    rpcClient,
    metadataReader: (deps.metadataReaderFactory || createErc20MetadataReader)({ rpcClient }),
    quoteReader: (deps.quoteReaderFactory || createRobinhoodWethUsdQuoteReader)({
      rpcClient, eventFallbackEnabled: false,
    }),
    v4RangeReader: rangeRepository,
  });
  const scanner = deps.scanner || createRobinhoodCanonicalLiquidityScanner({
    source, cursorRepository, poolRepository: snapshotRepository, refreshQueue,
  }, { maxBlocks: options.scanBatchBlocks });
  const refresher = deps.refresher || createRobinhoodCanonicalLiquidityRefresher({
    reader, snapshotRepository, refreshQueue,
  }, {
    owner: `robinhood-canonical-liquidity:${process.pid}`,
    limit: options.refreshBatchSize, leaseMs: options.claimLeaseMs,
    concurrency: options.refreshConcurrency,
    retryBaseMs: options.retryBaseMs, retryMaxMs: options.retryMaxMs,
    maxAnchorLagBlocks: options.maxAnchorLagBlocks,
  });
  const publisher = createRealtimePublisher(deps, options, database);
  return (deps.workerFactory || createRobinhoodCanonicalLiquidityWorker)({
    scanner, refresher, publisher, pool: rawDatabase.pool,
  }, options);
}

async function main(deps = {}) {
  const options = deps.options || config.robinhoodCanonicalLiquidityWorker;
  const logger = deps.logger || console;
  const rawDatabase = deps.database || db;
  if (!options.enabled) throw new Error('ROBINHOOD_CANONICAL_LIQUIDITY_ENABLED must be true');
  const baseRpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(
    deps.rpcOptions || liquidityRpcOptions(options)
  );
  const rpcClient = (deps.rpcGuardFactory || createRobinhoodLiveRpcGuard)(baseRpcClient, {
    role: 'canonical-liquidity',
  });
  const worker = composeWorker(deps, options, rawDatabase, rpcClient);
  const leases = (deps.leaseManagerFactory || createWorkerLeaseManager)({
    heartbeatMs: options.leaseHeartbeatMs, ttlMs: options.leaseTtlMs,
  });
  let stopping = false;
  const keepAlive = setInterval(() => {}, 60_000);
  async function shutdown() {
    if (stopping) return;
    stopping = true; clearInterval(keepAlive);
    await worker.stop(); await leases.stop({ releaseLeases: true });
    await (deps.close || (() => db.pool.end()))();
  }
  leases.start({
    key: LEASE_KEY, label: 'Robinhood canonical liquidity',
    metadata: { process: 'robinhood-canonical-liquidity', mode: 'canonical_journal' },
    metadataProvider: () => ({
      ...worker.getStatus(),
      rpcGuard: rpcClient.getGuardStatus(),
    }),
    start: async () => {
      try {
        await (deps.validateChainIds || validateRobinhoodProviderChainIds)(rpcClient);
        await (deps.assertCanonicalReady || assertCanonicalReady)(rawDatabase, options);
        await worker.start();
      } catch (error) {
        logger.error('[RobinhoodCanonicalLiquidityProcess] Startup failed:', error.message);
        throw error;
      }
    },
  });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  return Object.freeze({ shutdown, worker, leases });
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodCanonicalLiquidityProcess] Fatal:', error.message);
  process.exitCode = 1; void db.pool.end();
});

module.exports = { LEASE_KEY, assertCanonicalReady, liquidityRpcOptions, main };
