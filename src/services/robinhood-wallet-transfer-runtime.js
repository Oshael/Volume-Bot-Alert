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
  createRobinhoodRpcClient,
  validateRobinhoodProviderChainIds,
} = require('./robinhood-ingestion-worker');
const {
  createRobinhoodHolderTransferReader,
} = require('./robinhood-holder-transfer-reader');
const {
  createRobinhoodWalletTransferEndpointRoleReader,
} = require('./robinhood-wallet-transfer-endpoint-roles');
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
  return Object.freeze({
    providerChainIds,
    tickDeps: Object.freeze({
      source: (deps.sourceFactory || createRobinhoodWalletTransferLiveSourceRepository)({ database }),
      raw: (deps.rawFactory || createRobinhoodTokenTransferRepository)({ database }),
      projection: (deps.projectionFactory || createRobinhoodWalletTransferProjectionRepository)({
        database,
      }),
      evidence: (deps.evidenceFactory || createRobinhoodWalletTransferEvidenceReader)({
        transferReader, rpcClient, blockBatchSize: options.blockEvidenceBatchSize,
      }),
      roles: (deps.roleReaderFactory || createRobinhoodWalletTransferEndpointRoleReader)({
        rpcClient, batchSize: options.endpointRoleBatchSize,
      }),
    }),
  });
}

module.exports = { buildRobinhoodWalletTransferRuntime };
