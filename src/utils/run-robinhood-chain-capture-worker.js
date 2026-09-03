const config = require('../../config');
const db = require('../models/db');
const { createRobinhoodChainCaptureJournal } = require('../models/robinhood-chain-capture-journal');
const { createRobinhoodChainCaptureWorker } = require('../services/robinhood-chain-capture-worker');
const { createWorkerLeaseManager } = require('../services/worker-lease-manager');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');

const LEASE_KEY = 'robinhood-chain-capture-worker';

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
    rpcMinIntervalMs: 0 };
}

async function main(deps = {}) {
  const options = deps.options || config.robinhoodChainCaptureWorker;
  if (!options.enabled) throw new Error('ROBINHOOD_CHAIN_CAPTURE_ENABLED must be true');
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(
    deps.rpcOptions || captureRpcOptions(options)
  );
  const journal = deps.journal || createRobinhoodChainCaptureJournal({ database: deps.database || db });
  const worker = (deps.workerFactory || createRobinhoodChainCaptureWorker)(
    { rpcClient, journal }, options
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

module.exports = { LEASE_KEY, main, __private: { captureRpcOptions } };
