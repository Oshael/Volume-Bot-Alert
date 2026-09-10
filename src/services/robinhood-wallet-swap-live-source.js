'use strict';

const db = require('../models/db');
const {
  createRobinhoodCanonicalBlockSource,
} = require('../models/robinhood-canonical-block-source');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('./robinhood-ingestion-worker');

const RPC_SOURCE = 'rpc';
const CANONICAL_SOURCE = 'canonical_journal';
const DURABLE_OUTBOX_SOURCE = 'durable_outbox';

function normalizeRobinhoodWalletSwapLiveSource(value) {
  const normalized = String(value || RPC_SOURCE).trim().toLowerCase();
  if (![RPC_SOURCE, CANONICAL_SOURCE, DURABLE_OUTBOX_SOURCE].includes(normalized)) {
    const error = new Error(
      `ROBINHOOD_WALLET_SWAP_LIVE_SOURCE must be ${RPC_SOURCE}, ${CANONICAL_SOURCE}, or ${DURABLE_OUTBOX_SOURCE}`
    );
    error.code = 'configuration_error';
    error.fatal = true;
    throw error;
  }
  return normalized;
}

function blockTag(value) {
  return `0x${BigInt(String(value)).toString(16)}`;
}

async function resolveRobinhoodWalletSwapLiveSource(options = {}, deps = {}) {
  const sourceMode = normalizeRobinhoodWalletSwapLiveSource(options.sourceMode);
  if (sourceMode === CANONICAL_SOURCE) {
    const source = deps.canonicalBlockSource
      || (deps.canonicalBlockSourceFactory || createRobinhoodCanonicalBlockSource)({
        database: deps.database || db,
      });
    return Object.freeze({
      sourceMode,
      providerChainIds: Object.freeze({ canonical_journal: '4663' }),
      fetchBlock: source.loadBlock,
      fetchBlockHeader: source.loadHeader,
      readNodeHead: source.readHead,
    });
  }
  if (sourceMode === DURABLE_OUTBOX_SOURCE) {
    const error = new Error('durable_outbox is resolved by the wallet-swap worker');
    error.code = 'configuration_error';
    error.fatal = true;
    throw error;
  }
  const client = (deps.clientFactory || createRobinhoodRpcClient)(options.rpcOptions || {});
  const providerChainIds = await (
    deps.validateChainIds || validateRobinhoodProviderChainIds
  )(client);
  const fetchBlock = (number, fullTransactions) => client.request(
    'eth_getBlockByNumber', [blockTag(number), fullTransactions]
  );
  return Object.freeze({
    sourceMode, providerChainIds,
    fetchBlock: (number) => fetchBlock(number, true),
    fetchBlockHeader: (number) => fetchBlock(number, false),
    readNodeHead: () => client.request('eth_blockNumber'),
  });
}

module.exports = {
  CANONICAL_SOURCE, DURABLE_OUTBOX_SOURCE, RPC_SOURCE, normalizeRobinhoodWalletSwapLiveSource,
  resolveRobinhoodWalletSwapLiveSource,
};
