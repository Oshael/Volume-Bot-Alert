'use strict';

const db = require('../models/db');
const {
  createRobinhoodCanonicalHolderSource,
} = require('../models/robinhood-canonical-holder-source');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { resolveRobinhoodHolderRpcProvider } = require('./robinhood-holder-rpc');
const { createRobinhoodHolderTransferReader } = require('./robinhood-holder-transfer-reader');

const RPC_SOURCE = 'rpc';
const CANONICAL_SOURCE = 'canonical_journal';

function normalizeRobinhoodHolderLiveSource(value) {
  const normalized = String(value || RPC_SOURCE).trim().toLowerCase();
  if (![RPC_SOURCE, CANONICAL_SOURCE].includes(normalized)) {
    const error = new Error(
      `ROBINHOOD_HOLDER_LIVE_SOURCE must be ${RPC_SOURCE} or ${CANONICAL_SOURCE}`
    );
    error.code = 'configuration_error';
    error.fatal = true;
    throw error;
  }
  return normalized;
}

async function resolveRobinhoodHolderLiveSource(options = {}, deps = {}) {
  const sourceMode = normalizeRobinhoodHolderLiveSource(options.sourceMode);
  const database = deps.database || db;
  let reader;
  let providerName;

  if (sourceMode === CANONICAL_SOURCE) {
    reader = deps.reader
      || (deps.canonicalReaderFactory || createRobinhoodCanonicalHolderSource)({ database });
    providerName = CANONICAL_SOURCE;
  } else {
    const provider = resolveRobinhoodHolderRpcProvider(
      deps.env || process.env, options.providerName
    );
    const rpcClient = deps.rpcClient || (deps.rpcClientFactory || createEvmJsonRpcClient)({
      providers: [provider], timeoutMs: options.rpcTimeoutMs, maxRetries: 1,
    });
    reader = deps.reader || (deps.readerFactory || createRobinhoodHolderTransferReader)({
      rpcClient,
      ...(options.addressShardConcurrency == null ? {} : {
        addressShardConcurrency: options.addressShardConcurrency,
      }),
    });
    providerName = provider.name;
  }

  await reader.assertChain();
  return Object.freeze({ sourceMode, providerName, reader });
}

module.exports = {
  CANONICAL_SOURCE,
  RPC_SOURCE,
  normalizeRobinhoodHolderLiveSource,
  resolveRobinhoodHolderLiveSource,
};
