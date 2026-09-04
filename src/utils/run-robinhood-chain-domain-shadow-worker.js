'use strict';

const config = require('../../config');
const db = require('../models/db');
const {
  createRobinhoodChainDomainShadowWorker,
} = require('../services/robinhood-chain-domain-shadow-worker');
const { createWorkerLeaseManager } = require('../services/worker-lease-manager');

const LEASE_KEY = 'robinhood-chain-domain-shadow-worker';

async function main(deps = {}) {
  const options = deps.options || config.robinhoodChainDomainShadowWorker;
  if (!options.enabled) throw new Error('ROBINHOOD_CHAIN_DOMAIN_SHADOW_ENABLED must be true');
  const worker = (deps.workerFactory || createRobinhoodChainDomainShadowWorker)(
    { database: deps.database || db }, options
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
    key: LEASE_KEY, label: 'Robinhood canonical domain shadow',
    metadata: { process: 'robinhood-chain-domain-shadow', mode: 'shadow_compare' },
    metadataProvider: worker.getStatus,
    start: worker.start,
  });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  return Object.freeze({ shutdown, worker, leases });
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodChainDomainShadowProcess] Fatal:', error.message);
  process.exitCode = 1; void db.pool.end();
});

module.exports = { LEASE_KEY, main };
