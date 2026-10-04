const config = require('../../config');
const db = require('../models/db');
const { createRobinhoodChainCaptureJournal } = require('../models/robinhood-chain-capture-journal');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createRobinhoodChainCaptureWorker } = require('../services/robinhood-chain-capture-worker');
const {
  createRobinhoodChainRecoveryPlanner,
} = require('../services/robinhood-chain-recovery-planner');
const {
  createRobinhoodV3BalanceSnapshotter,
} = require('../services/robinhood-v3-balance-snapshotter');
const { createWorkerLeaseManager } = require('../services/worker-lease-manager');
const partitionProvisioner = require('./provision-robinhood-chain-journal-partition');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');

const LEASE_KEY = 'robinhood-chain-capture-worker';

async function resolveEventShadowEnabled(database, requested) {
  const result = await database.query(`SELECT active.relkind AS active_kind,
      to_regclass('public.robinhood_chain_events_shadow') IS NOT NULL AS shadow_present
    FROM pg_class active WHERE active.oid=to_regclass('public.robinhood_chain_events')`);
  const row = result.rows[0];
  if (row?.active_kind === 'p') {
    if (row.shadow_present) throw new Error('partitioned events still have a shadow relation');
    return false;
  }
  if (row?.active_kind !== 'r') throw new Error('active Robinhood event relation is unavailable');
  if (requested && !row.shadow_present) throw new Error('event shadow is unavailable');
  return requested === true;
}

async function resolveTransactionStorage(database, requested) {
  const result = await database.query(`SELECT active.relkind AS active_kind,
      shadow.relkind AS shadow_kind
    FROM pg_class active
    LEFT JOIN pg_class shadow
      ON shadow.oid=to_regclass('public.robinhood_chain_transactions_shadow')
    WHERE active.oid=to_regclass('public.robinhood_chain_transactions')`);
  const row = result.rows[0];
  if (row?.active_kind === 'p') {
    if (row.shadow_kind) throw new Error('partitioned transactions still have a shadow relation');
    return { partitioned: true, shadowEnabled: false };
  }
  if (row?.active_kind !== 'r' || requested && row.shadow_kind !== 'p') {
    throw new Error('active transaction layout or partitioned shadow is unavailable');
  }
  return { partitioned: false, shadowEnabled: requested === true };
}

async function resolveTransactionShadowEnabled(database, requested) {
  if (!requested) return false;
  return (await resolveTransactionStorage(database, requested)).shadowEnabled;
}

function capturePartitionProvisioner(database, storage, provisioner) {
  if (!storage.partitioned) return {};
  const runner = provisioner || partitionProvisioner;
  return { ensurePartition: (start) => runner.run(
    { start, apply: true }, { database, closePool: false }
  ) };
}

function captureRpcOptions(options, base = config.robinhoodIngestionWorker) {
  let parsed;
  try { parsed = new URL(String(options.rpcUrl || '')); } catch (_) {
    parsed = null;
  }
  const hostname = parsed?.hostname?.toLowerCase();
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    const error = new Error('ROBINHOOD_CHAIN_CAPTURE_RPC_URL must be an explicit loopback RPC URL');
    error.code = 'configuration_error';
    throw error;
  }
  return { ...base, publicRpcUrl: parsed.toString(), useAlchemy: false, useDrpc: false,
    rpcTimeoutMs: options.rpcTimeoutMs, rpcMaxRetries: 0, rpcMinIntervalMs: 0 };
}

async function main(deps = {}) {
  const options = deps.options || config.robinhoodChainCaptureWorker;
  if (!options.enabled) throw new Error('ROBINHOOD_CHAIN_CAPTURE_ENABLED must be true');
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(
    deps.rpcOptions || captureRpcOptions(options)
  );
  const database = deps.database || db;
  const eventShadowEnabled = await (deps.resolveEventShadowEnabled || resolveEventShadowEnabled)(
    database, options.eventShadowEnabled
  );
  const transactionStorage = await (
    deps.resolveTransactionStorage || resolveTransactionStorage
  )(database, options.transactionShadowEnabled);
  const effectiveOptions = { ...options, eventShadowEnabled,
    transactionShadowEnabled: transactionStorage.shadowEnabled,
    transactionPartitioned: transactionStorage.partitioned };
  const journal = deps.journal || createRobinhoodChainCaptureJournal({
    database, shadowEnabled: eventShadowEnabled,
    holderCoverageProtectionEnabled: options.holderCoverageProtectionEnabled,
    transactionShadowEnabled: transactionStorage.shadowEnabled,
    transactionPartitioned: transactionStorage.partitioned,
  });
  const recoveryPlanner = deps.recoveryPlanner
    || (deps.recoveryPlannerFactory || createRobinhoodChainRecoveryPlanner)(
      { rpcClient, journal }, { maxDepth: options.reorgMaxDepth }
    );
  let v3Snapshotter = deps.v3Snapshotter;
  if (!v3Snapshotter) {
    const catalog = deps.catalog || (deps.catalogFactory || createRobinhoodPersistenceRepository)({
      database,
    });
    const seedPools = await catalog.listActivePools();
    v3Snapshotter = (deps.v3SnapshotterFactory || createRobinhoodV3BalanceSnapshotter)(
      { rpcClient }, { seedPools }
    );
  }
  const worker = (deps.workerFactory || createRobinhoodChainCaptureWorker)(
    { rpcClient, journal, recoveryPlanner, v3Snapshotter,
      ...capturePartitionProvisioner(
        database, transactionStorage, deps.partitionProvisioner
      ) }, effectiveOptions
  );
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
    key: LEASE_KEY, label: 'Robinhood canonical chain capture',
    metadata: { process: 'robinhood-chain-capture', mode: 'shadow' },
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
  console.error('[RobinhoodChainCaptureProcess] Fatal:', error.message);
  process.exitCode = 1; void db.pool.end();
});

module.exports = { LEASE_KEY, captureRpcOptions, main, resolveEventShadowEnabled,
  resolveTransactionShadowEnabled, resolveTransactionStorage,
  __private: { captureRpcOptions } };
