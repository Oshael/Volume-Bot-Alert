const db = require('../models/db');
const {
  createRobinhoodTokenTransferRepository,
} = require('../models/robinhood-token-transfer-persistence');
const {
  createRobinhoodWalletTransferLiveSourceRepository,
} = require('../models/robinhood-wallet-transfer-live-source');
const {
  createRobinhoodWalletTransferProjectionRepository,
} = require('../models/robinhood-wallet-transfer-projection');
const {
  createRobinhoodWalletPositionRepository,
} = require('../models/robinhood-wallet-position');
const {
  createRobinhoodTransactionPositionRepository,
} = require('../models/robinhood-transaction-position');
const {
  createRobinhoodCanonicalBlockSource,
} = require('../models/robinhood-canonical-block-source');
const {
  createRobinhoodCanonicalHolderSource,
} = require('../models/robinhood-canonical-holder-source');
const {
  createRobinhoodCanonicalWalletTransferSource,
} = require('../models/robinhood-canonical-wallet-transfer-source');
const {
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('./robinhood-ingestion-worker');
const {
  createRobinhoodHolderTransferReader,
} = require('./robinhood-holder-transfer-reader');
const {
  createRobinhoodWalletTransferEvidenceReader,
} = require('./robinhood-wallet-transfer-evidence-reader');
const {
  createRobinhoodTransactionPositionResolver,
} = require('./robinhood-transaction-position-resolver');

const RPC_SOURCE = 'rpc';
const CANONICAL_SOURCE = 'canonical_journal';

function normalizeRobinhoodWalletTransferSource(value) {
  const normalized = String(value || RPC_SOURCE).trim().toLowerCase();
  if (![RPC_SOURCE, CANONICAL_SOURCE].includes(normalized)) {
    throw Object.assign(new Error(
      `ROBINHOOD_WALLET_TRANSFER_LIVE_SOURCE must be ${RPC_SOURCE} or ${CANONICAL_SOURCE}`
    ), { code: 'configuration_error', fatal: true });
  }
  return normalized;
}

function canonicalBlockBatchClient(source) {
  return Object.freeze({
    async requestBatch(requests) {
      if (!Array.isArray(requests)) throw new TypeError('canonical block batch must be a list');
      return Promise.all(requests.map((request) => {
        if (request?.method !== 'eth_getBlockByNumber' || request?.params?.[1] !== true) {
          throw Object.assign(new Error('unsupported canonical block request'), {
            code: 'source_contract_error', fatal: true,
          });
        }
        return source.loadBlock(BigInt(request.params[0]).toString());
      }));
    },
  });
}

function runtimeDependencies(deps) {
  return {
    database: db,
    canonicalTransferReaderFactory: createRobinhoodCanonicalHolderSource,
    canonicalEvidenceFactory: createRobinhoodCanonicalWalletTransferSource,
    canonicalBlockSourceFactory: createRobinhoodCanonicalBlockSource,
    rpcClientFactory: createRobinhoodRpcClient,
    validateChainIds: validateRobinhoodProviderChainIds,
    transferReaderFactory: createRobinhoodHolderTransferReader,
    evidenceFactory: createRobinhoodWalletTransferEvidenceReader,
    positionFactory: createRobinhoodWalletPositionRepository,
    transactionPositionRepositoryFactory: createRobinhoodTransactionPositionRepository,
    transactionPositionResolverFactory: createRobinhoodTransactionPositionResolver,
    sourceFactory: createRobinhoodWalletTransferLiveSourceRepository,
    rawFactory: createRobinhoodTokenTransferRepository,
    projectionFactory: createRobinhoodWalletTransferProjectionRepository,
    ...deps,
  };
}

async function buildRobinhoodWalletTransferRuntime(options = {}, deps = {}) {
  const resolved = runtimeDependencies(deps);
  const database = resolved.database;
  const sourceMode = normalizeRobinhoodWalletTransferSource(options.sourceMode);
  let providerChainIds;
  let evidence;
  let positionClient;
  if (sourceMode === CANONICAL_SOURCE) {
    const transferReader = resolved.canonicalTransferReaderFactory({ database });
    await transferReader.assertChain();
    evidence = resolved.canonicalEvidenceFactory({ database, transferReader });
    const blockSource = resolved.canonicalBlockSourceFactory({ database });
    positionClient = canonicalBlockBatchClient(blockSource);
    providerChainIds = Object.freeze({ canonical_journal: '4663' });
  } else {
    const rpcClient = resolved.rpcClient || resolved.rpcClientFactory(options.rpcOptions);
    providerChainIds = await resolved.validateChainIds(rpcClient);
    const transferReader = resolved.transferReaderFactory({
      rpcClient, addressShardConcurrency: options.addressShardConcurrency,
      addressFilterLimit: options.addressFilterLimit,
    });
    evidence = resolved.evidenceFactory({
      transferReader, rpcClient, blockBatchSize: options.blockEvidenceBatchSize,
    });
    positionClient = rpcClient;
  }
  const positions = resolved.positionFactory({ database });
  const transactionPositionRepository = resolved.transactionPositionRepositoryFactory({ database });
  const transactionPositions = resolved.transactionPositionResolverFactory({
    rpcClient: positionClient, repository: transactionPositionRepository,
  });
  return Object.freeze({
    sourceMode, providerChainIds,
    tickDeps: Object.freeze({
      source: resolved.sourceFactory({ database }),
      raw: resolved.rawFactory({ database }),
      projection: resolved.projectionFactory({
        database, positionProjection: positions,
      }),
      positions,
      transactionPositions,
      evidence,
    }),
  });
}

module.exports = {
  CANONICAL_SOURCE, RPC_SOURCE, buildRobinhoodWalletTransferRuntime,
  normalizeRobinhoodWalletTransferSource,
  __private: { canonicalBlockBatchClient, runtimeDependencies },
};
