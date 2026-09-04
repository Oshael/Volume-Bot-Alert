'use strict';

const db = require('../models/db');
const {
  createRobinhoodChainDomainOutboxRepository,
} = require('../models/robinhood-chain-domain-outbox');
const {
  createRobinhoodCanonicalHeadCandidateRepository,
} = require('../models/robinhood-canonical-head-candidate');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createRobinhoodCanonicalHeadRunner } = require('./robinhood-canonical-head-runner');
const { createRobinhoodLiveRpcGuard } = require('./robinhood-live-rpc-guard');
const { createRobinhoodOnchainPipeline } = require('./robinhood-onchain-pipeline');

async function createRobinhoodCanonicalHeadRuntime(deps = {}, options = {}) {
  if (typeof deps.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const database = deps.database || db;
  const rpcClient = (deps.rpcGuardFactory || createRobinhoodLiveRpcGuard)(deps.rpcClient, {
    role: 'canonical-head',
  });
  const catalog = deps.catalog || (deps.catalogFactory || createRobinhoodPersistenceRepository)({
    database,
  });
  const seedPools = await catalog.listActivePools();
  const pipeline = (deps.pipelineFactory || createRobinhoodOnchainPipeline)({
    rpcClient,
    seedPools,
    v4LiquidityReader: catalog,
    captureMode: true,
    retainRollbackState: false,
    windowAggregationEnabled: false,
    timestampConcurrency: options.timestampConcurrency,
    timestampBatchSize: options.timestampBatchSize,
    observationConcurrency: options.observationConcurrency,
    policyOptions: options.policyOptions,
  });
  const outbox = deps.outbox || createRobinhoodChainDomainOutboxRepository({ database });
  const headRepository = deps.headRepository
    || (deps.candidateRepositoryFactory || createRobinhoodCanonicalHeadCandidateRepository)({
      database,
    });
  const runner = (deps.runnerFactory || createRobinhoodCanonicalHeadRunner)({
    outbox, pipeline, headRepository,
    options: {
      owner: options.owner,
      leaseMs: options.leaseMs,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    },
  });

  return Object.freeze({
    runOnce: runner.runOnce,
    snapshot: () => ({
      owner: runner.owner,
      tracked: pipeline.snapshot().tracked,
      rpcGuard: rpcClient.getGuardStatus(),
    }),
  });
}

module.exports = { createRobinhoodCanonicalHeadRuntime };
