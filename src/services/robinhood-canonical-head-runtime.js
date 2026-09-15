'use strict';

const db = require('../models/db');
const {
  createRobinhoodChainDomainOutboxRepository,
} = require('../models/robinhood-chain-domain-outbox');
const {
  createRobinhoodCanonicalHeadCandidateRepository,
} = require('../models/robinhood-canonical-head-candidate');
const { createRobinhoodHeadCaptureRepository } = require('../models/robinhood-head-capture');
const {
  createRobinhoodPoolLiquiditySnapshotRepository,
} = require('../models/robinhood-pool-liquidity-snapshot');
const { createRobinhoodPersistenceRepository } = require('../models/robinhood-persistence');
const { createErc20MetadataReader } = require('./evm-erc20-metadata');
const { createRobinhoodCanonicalHeadRunner } = require('./robinhood-canonical-head-runner');
const { createRobinhoodLiveRpcGuard } = require('./robinhood-live-rpc-guard');
const { createRobinhoodOnchainPipeline } = require('./robinhood-onchain-pipeline');
const { createRobinhoodStockUsdQuoteReader } = require('./robinhood-stock-usd-quote');
const { createRobinhoodWethUsdQuoteReader } = require('./robinhood-weth-usd-quote');

function createValuationReaders(deps, database, rpcClient) {
  const metadataReader = (deps.metadataReaderFactory || createErc20MetadataReader)({ rpcClient });
  const repository = deps.stockReferenceRepository
    || createRobinhoodPoolLiquiditySnapshotRepository({ database });
  const quoteReader = (deps.quoteReaderFactory || createRobinhoodWethUsdQuoteReader)({
    rpcClient, eventFallbackEnabled: false, checkpointRepository: repository,
  });
  const stockQuoteReader = deps.stockQuoteReader
    || (deps.stockQuoteReaderFactory || createRobinhoodStockUsdQuoteReader)({
      rpcClient, repository, metadataReader, wethQuoteReader: quoteReader,
    });
  return { metadataReader, quoteReader, stockQuoteReader };
}

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
  const readers = createValuationReaders(deps, database, rpcClient);
  const pipeline = (deps.pipelineFactory || createRobinhoodOnchainPipeline)({
    rpcClient, ...readers,
    seedPools,
    v4LiquidityReader: catalog,
    captureMode: true,
    requireV3Snapshots: true,
    retainRollbackState: false,
    windowAggregationEnabled: false,
    timestampConcurrency: options.timestampConcurrency,
    timestampBatchSize: options.timestampBatchSize,
    observationConcurrency: options.observationConcurrency,
    policyOptions: options.policyOptions,
  });
  const outbox = deps.outbox || createRobinhoodChainDomainOutboxRepository({ database });
  const repositoryFactory = options.publishEnabled === true
    ? (deps.publishRepositoryFactory || createRobinhoodHeadCaptureRepository)
    : (deps.candidateRepositoryFactory || createRobinhoodCanonicalHeadCandidateRepository);
  const headRepository = deps.headRepository || repositoryFactory({ database });
  const runner = (deps.runnerFactory || createRobinhoodCanonicalHeadRunner)({
    outbox, pipeline, headRepository,
    options: {
      owner: options.owner,
      leaseMs: options.leaseMs,
      maxBlocks: options.maxBlocks,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    },
  });

  function snapshot() {
    const pipelineStatus = pipeline.snapshot();
    return {
      owner: runner.owner,
      mode: options.publishEnabled === true ? 'canonical_publish' : 'canonical_canary',
      tracked: pipelineStatus.tracked,
      enrichment: pipelineStatus.enrichment,
      rpcGuard: rpcClient.getGuardStatus(),
    };
  }

  return Object.freeze({ runOnce: runner.runOnce, snapshot });
}

module.exports = { createRobinhoodCanonicalHeadRuntime };
