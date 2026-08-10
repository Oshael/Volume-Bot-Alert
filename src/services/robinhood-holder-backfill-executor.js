const db = require('../models/db');
const { createRobinhoodHolderBackfillRepository } = require('../models/robinhood-holder-backfill');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { resolveRobinhoodHolderRpcProvider } = require('./robinhood-holder-rpc');
const { createRobinhoodHolderTransferReader } = require('./robinhood-holder-transfer-reader');

const PROVIDER_NAME = 'robinhood-holder-backfill';

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function resolveRpcProvider(env = process.env) {
  return resolveRobinhoodHolderRpcProvider(env, PROVIDER_NAME);
}

function createRobinhoodHolderBackfillExecutor(options = {}) {
  const repository = options.repository;
  const reader = options.reader;
  if (typeof repository?.getNextToken !== 'function'
      || typeof repository?.commitRange !== 'function'
      || typeof repository?.markResyncing !== 'function') {
    throw new TypeError('holder backfill repository is required');
  }
  if (typeof reader?.getSafeHead !== 'function'
      || typeof reader?.matchesCheckpoint !== 'function'
      || typeof reader?.readRange !== 'function') {
    throw new TypeError('holder transfer reader is required');
  }

  async function runOnce(input = {}) {
    const rangeSize = boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize');
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const head = await reader.getSafeHead(confirmations);
    const state = await repository.getNextToken({ throughBlock: head.safeHead });
    if (!state) return Object.freeze({ status: 'idle', safeHead: head.safeHead });
    if (state.liveThroughBlock !== null) {
      const matches = await reader.matchesCheckpoint({
        number: state.liveThroughBlock, hash: state.liveThroughHash,
      });
      if (!matches) {
        const isolated = await repository.markResyncing(state);
        return Object.freeze({ ...isolated, reason: 'holder_backfill_checkpoint_orphaned' });
      }
    }
    const fromBlock = BigInt(state.backfillNextBlock);
    const safeHead = BigInt(head.safeHead);
    const candidateEnd = fromBlock + BigInt(rangeSize - 1);
    const toBlock = candidateEnd < safeHead ? candidateEnd : safeHead;
    const range = await reader.readRange({
      tokenAddress: state.tokenAddress,
      fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
    });
    const committed = await repository.commitRange(range);
    if (committed.status !== 'committed') {
      return Object.freeze({ ...committed, safeHead: head.safeHead, atBarrier: false });
    }
    return Object.freeze({
      ...committed, safeHead: head.safeHead,
      atBarrier: BigInt(committed.backfillNextBlock) > safeHead,
    });
  }

  return Object.freeze({ runOnce });
}

function createConfiguredRobinhoodHolderBackfillExecutor(options = {}) {
  const env = options.env || process.env;
  const rpcClient = options.rpcClient || createEvmJsonRpcClient({
    providers: [resolveRpcProvider(env)],
    timeoutMs: boundedInteger(env.ROBINHOOD_RPC_TIMEOUT_MS, 15_000, 1000, 60_000, 'RPC timeout'),
    maxRetries: 1,
  });
  const database = options.database || db;
  const repository = options.repository || createRobinhoodHolderBackfillRepository({ database });
  const reader = options.reader || createRobinhoodHolderTransferReader({ rpcClient });
  return createRobinhoodHolderBackfillExecutor({ repository, reader });
}

module.exports = {
  createConfiguredRobinhoodHolderBackfillExecutor,
  createRobinhoodHolderBackfillExecutor,
  __private: { resolveRpcProvider },
};
