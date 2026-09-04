'use strict';

const config = require('../../config');
const db = require('../models/db');
const { createRobinhoodCanonicalHeadWorker } = require('../services/robinhood-canonical-head-worker');
const { createWorkerLeaseManager } = require('../services/worker-lease-manager');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');
const { captureRpcOptions } = require('./run-robinhood-chain-capture-worker');

const LEASE_KEY = 'robinhood-canonical-head-worker';

async function main(deps = {}) {
  const options = deps.options || config.robinhoodCanonicalHeadWorker;
  if (!options.enabled) throw new Error('ROBINHOOD_CANONICAL_HEAD_ENABLED must be true');
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(
    deps.rpcOptions || captureRpcOptions(options)
  );
  const worker = (deps.workerFactory || createRobinhoodCanonicalHeadWorker)({
    database: deps.database || db, rpcClient,
  }, options);
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
    key: LEASE_KEY, label: 'Robinhood canonical head',
    metadata: { process: 'robinhood-canonical-head', mode: 'canonical_canary' },
    metadataProvider: worker.getStatus,
    start: async () => {
      await (deps.validateChainIds || validateRobinhoodProviderChainIds)(rpcClient);
      await worker.start({ onFatal: (error) => leases.halt(LEASE_KEY, error) });
    },
  });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  return Object.freeze({ shutdown, worker, leases });
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodCanonicalHeadProcess] Fatal:', error.message);
  process.exitCode = 1; void db.pool.end();
});

module.exports = { LEASE_KEY, main };
