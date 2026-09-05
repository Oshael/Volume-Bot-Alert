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
const CAPTURE_LEASE_KEY = 'robinhood-chain-capture-worker';
const LEGACY_LEASE_KEY = 'robinhood-head-capture-worker';
const SHADOW_LEASE_KEY = 'robinhood-chain-domain-shadow-worker';

async function assertPublishReady(database) {
  const result = await database.query(
    `SELECT lease_key FROM worker_leases
      WHERE lease_key=ANY($1::varchar[]) AND lease_until>NOW()`,
    [[CAPTURE_LEASE_KEY, LEGACY_LEASE_KEY, SHADOW_LEASE_KEY]]
  );
  const active = new Set(result.rows.map((row) => row.lease_key));
  if (!active.has(CAPTURE_LEASE_KEY)) {
    const error = new Error('canonical chain capture must be active before publish');
    error.code = 'canonical_capture_inactive';
    throw error;
  }
  for (const key of [LEGACY_LEASE_KEY, SHADOW_LEASE_KEY]) {
    if (!active.has(key)) continue;
    const error = new Error(`${key} must be inactive before canonical publish`);
    error.code = 'canonical_publish_writer_conflict';
    throw error;
  }
}

async function main(deps = {}) {
  const options = deps.options || config.robinhoodCanonicalHeadWorker;
  const logger = deps.logger || console;
  const database = deps.database || db;
  if (!options.enabled) throw new Error('ROBINHOOD_CANONICAL_HEAD_ENABLED must be true');
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(
    deps.rpcOptions || captureRpcOptions(options)
  );
  const worker = (deps.workerFactory || createRobinhoodCanonicalHeadWorker)({
    database, rpcClient,
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
    metadata: {
      process: 'robinhood-canonical-head',
      mode: options.publishEnabled === true ? 'canonical_publish' : 'canonical_canary',
    },
    metadataProvider: () => {
      const status = worker.getStatus();
      const { runtime, ...metadata } = status;
      return { ...metadata, canonicalRuntime: runtime };
    },
    start: async () => {
      try {
        await (deps.validateChainIds || validateRobinhoodProviderChainIds)(rpcClient);
        if (options.publishEnabled === true) {
          await (deps.assertPublishReady || assertPublishReady)(database);
        }
        await worker.start({ onFatal: (error) => leases.halt(LEASE_KEY, error) });
      } catch (error) {
        logger.error('[RobinhoodCanonicalHeadProcess] Startup failed:', error.message);
        throw error;
      }
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

module.exports = { LEASE_KEY, assertPublishReady, main };
