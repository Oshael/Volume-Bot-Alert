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
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('./robinhood-ingestion-worker');
const {
  createRobinhoodHolderTransferReader,
} = require('./robinhood-holder-transfer-reader');
const {
  createRobinhoodWalletTransferEvidenceReader,
} = require('./robinhood-wallet-transfer-evidence-reader');

async function buildRobinhoodWalletTransferRuntime(options = {}, deps = {}) {
  const database = deps.database || db;
  const rpcClient = deps.rpcClient
    || (deps.rpcClientFactory || createRobinhoodRpcClient)(options.rpcOptions);
  const providerChainIds = await (
    deps.validateChainIds || validateRobinhoodProviderChainIds
  )(rpcClient);
  const transferReader = (deps.transferReaderFactory || createRobinhoodHolderTransferReader)({
    rpcClient, addressShardConcurrency: options.addressShardConcurrency,
  });
  const positions = (deps.positionFactory || createRobinhoodWalletPositionRepository)({ database });
  return Object.freeze({
    providerChainIds,
    tickDeps: Object.freeze({
      source: (deps.sourceFactory || createRobinhoodWalletTransferLiveSourceRepository)({ database }),
      raw: (deps.rawFactory || createRobinhoodTokenTransferRepository)({ database }),
      projection: (deps.projectionFactory || createRobinhoodWalletTransferProjectionRepository)({
        database, positionProjection: positions,
      }),
      positions,
      evidence: (deps.evidenceFactory || createRobinhoodWalletTransferEvidenceReader)({
        transferReader, rpcClient, blockBatchSize: options.blockEvidenceBatchSize,
      }),
    }),
  });
}

module.exports = { buildRobinhoodWalletTransferRuntime };
