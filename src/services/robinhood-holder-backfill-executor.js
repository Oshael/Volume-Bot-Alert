const db = require('../models/db');
const { createRobinhoodHolderBackfillRepository } = require('../models/robinhood-holder-backfill');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { resolveRobinhoodHolderRpcProvider } = require('./robinhood-holder-rpc');
const { createRobinhoodHolderTransferReader } = require('./robinhood-holder-transfer-reader');

const PROVIDER_NAME = 'robinhood-holder-backfill';
const REQUIRED_DRIFT_OBSERVATIONS = 3;
const DEFAULT_DRIFT_RECHECK_MS = 60_000;
const DEFAULT_RECEIPT_BLOCK_LIMIT = 250;
const DEFAULT_RECEIPT_BATCH_SIZE = 25;

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
      || typeof reader?.readRange !== 'function'
      || typeof reader?.readReceiptRange !== 'function') {
    throw new TypeError('holder transfer reader is required');
  }
  const now = options.now || Date.now;
  const driftRecheckMs = boundedInteger(
    options.driftRecheckMs, DEFAULT_DRIFT_RECHECK_MS, 1000, 600_000, 'driftRecheckMs'
  );
  const receiptBlockLimit = boundedInteger(
    options.receiptBlockLimit, DEFAULT_RECEIPT_BLOCK_LIMIT, 1, 1000, 'receiptBlockLimit'
  );
  const receiptBatchSize = boundedInteger(
    options.receiptBatchSize, DEFAULT_RECEIPT_BATCH_SIZE, 1, 100, 'receiptBatchSize'
  );
  const driftEvidence = new Map();

  function clockMs() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new Error('holder backfill clock is invalid');
    return value;
  }

  function observeDrift(result, state, observedAtMs) {
    const previous = driftEvidence.get(state.tokenAddress);
    const observations = previous?.fingerprint === result.fingerprint
      && previous.fromBlock === state.backfillNextBlock
      ? previous.observations + 1 : 1;
    const evidence = Object.freeze({
      fingerprint: result.fingerprint,
      fromBlock: state.backfillNextBlock,
      observations,
      nextObservationAtMs: observedAtMs + driftRecheckMs,
    });
    driftEvidence.set(state.tokenAddress, evidence);
    return evidence;
  }

  function deferDrift(state, observedAtMs) {
    const evidence = Object.freeze({
      fromBlock: state.backfillNextBlock, observations: 0,
      nextObservationAtMs: observedAtMs + driftRecheckMs,
    });
    driftEvidence.set(state.tokenAddress, evidence);
    return evidence;
  }

  async function retryNarrowedRange(suspicion, state) {
    const fromBlock = BigInt(state.backfillNextBlock);
    const toBlock = fromBlock + BigInt(receiptBlockLimit - 1);
    let narrowedRange;
    try {
      narrowedRange = await reader.readRange({
        tokenAddress: state.tokenAddress,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
      });
    } catch (error) {
      const evidence = deferDrift(state, clockMs());
      return Object.freeze({
        status: 'drift-unverified', tokenAddress: state.tokenAddress,
        reason: 'holder_narrowed_range_unavailable',
        originalFailedBlock: suspicion.failedBlock,
        error: String(error?.code || error?.message || error).slice(0, 160),
        nextObservationAt: new Date(evidence.nextObservationAtMs).toISOString(),
      });
    }
    const narrowed = await repository.commitRange(narrowedRange);
    if (narrowed.status === 'drift-suspected') {
      return verifyDriftWithReceipts(narrowed, state);
    }
    driftEvidence.delete(state.tokenAddress);
    return Object.freeze({
      ...narrowed, recoverySource: 'adaptive-range',
      originalFailedBlock: suspicion.failedBlock,
    });
  }

  async function verifyDriftWithReceipts(suspicion, state) {
    const fromBlock = BigInt(state.backfillNextBlock);
    const failedBlock = BigInt(suspicion.failedBlock);
    const receiptBlocks = failedBlock - fromBlock + 1n;
    if (receiptBlocks < 1n || receiptBlocks > BigInt(receiptBlockLimit)) {
      if (receiptBlocks > BigInt(receiptBlockLimit)) {
        return retryNarrowedRange(suspicion, state);
      }
      const evidence = deferDrift(state, clockMs());
      return Object.freeze({
        status: 'drift-unverified', tokenAddress: state.tokenAddress,
        reason: 'holder_receipt_range_too_wide', receiptBlocks: receiptBlocks.toString(),
        receiptBlockLimit, nextObservationAt: new Date(evidence.nextObservationAtMs).toISOString(),
      });
    }
    let receiptRange;
    try {
      receiptRange = await reader.readReceiptRange({
        tokenAddress: state.tokenAddress, fromBlock: state.backfillNextBlock,
        toBlock: suspicion.failedBlock, batchSize: receiptBatchSize,
      });
    } catch (error) {
      const evidence = deferDrift(state, clockMs());
      return Object.freeze({
        status: 'drift-unverified', tokenAddress: state.tokenAddress,
        reason: 'holder_receipt_unavailable',
        error: String(error?.code || error?.message || error).slice(0, 160),
        nextObservationAt: new Date(evidence.nextObservationAtMs).toISOString(),
      });
    }
    let verified = await repository.commitRange(receiptRange);
    if (verified.status !== 'drift-suspected') {
      driftEvidence.delete(state.tokenAddress);
      return Object.freeze({ ...verified, recoverySource: 'receipts' });
    }
    const observedAtMs = clockMs();
    const evidence = observeDrift(verified, state, observedAtMs);
    if (evidence.observations >= REQUIRED_DRIFT_OBSERVATIONS) {
      verified = await repository.commitRange({ ...receiptRange, confirmDrift: true });
      driftEvidence.delete(state.tokenAddress);
    }
    return Object.freeze({
      ...verified, verificationSource: 'receipts', observations: evidence.observations,
      requiredObservations: REQUIRED_DRIFT_OBSERVATIONS,
      nextObservationAt: new Date(evidence.nextObservationAtMs).toISOString(),
    });
  }

  async function runOnce(input = {}) {
    const rangeSize = boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize');
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const shardCount = boundedInteger(input.shardCount, 1, 1, 8, 'shardCount');
    const shardIndex = boundedInteger(input.shardIndex, 0, 0, shardCount - 1, 'shardIndex');
    const selectedAtMs = clockMs();
    const head = await reader.getSafeHead(confirmations);
    const excludeTokenAddresses = [...driftEvidence.entries()]
      .filter(([, evidence]) => evidence.nextObservationAtMs > selectedAtMs)
      .map(([tokenAddress]) => tokenAddress);
    const state = await repository.getNextToken({
      throughBlock: head.safeHead, excludeTokenAddresses, shardCount, shardIndex,
    });
    if (!state) return Object.freeze({ status: 'idle', safeHead: head.safeHead });
    try {
      if (state.liveThroughBlock !== null) {
        const matches = await reader.matchesCheckpoint({
          number: state.liveThroughBlock, hash: state.liveThroughHash,
        });
        if (!matches) {
          driftEvidence.delete(state.tokenAddress);
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
      let committed = await repository.commitRange(range);
      if (committed.status === 'drift-suspected') {
        committed = await verifyDriftWithReceipts(committed, state);
      } else {
        driftEvidence.delete(state.tokenAddress);
      }
      if (committed.status !== 'committed') {
        return Object.freeze({
          ...committed, safeHead: head.safeHead, atBarrier: false,
        });
      }
      return Object.freeze({
        ...committed, safeHead: head.safeHead,
        atBarrier: BigInt(committed.backfillNextBlock) > safeHead,
      });
    } catch (error) {
      if (error.code !== 'holder_backfill_cursor_stale') throw error;
      driftEvidence.delete(state.tokenAddress);
      return Object.freeze({
        status: 'superseded', tokenAddress: state.tokenAddress,
        reason: error.code, expectedBackfillNextBlock: state.backfillNextBlock,
        safeHead: head.safeHead, atBarrier: false,
      });
    }
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
  return createRobinhoodHolderBackfillExecutor({
    repository, reader,
    driftRecheckMs: boundedInteger(
      env.ROBINHOOD_HOLDER_DRIFT_RECHECK_MS,
      DEFAULT_DRIFT_RECHECK_MS, 1000, 600_000, 'drift recheck interval'
    ),
    receiptBlockLimit: boundedInteger(
      env.ROBINHOOD_HOLDER_RECEIPT_BLOCK_LIMIT,
      DEFAULT_RECEIPT_BLOCK_LIMIT, 1, 1000, 'receipt block limit'
    ),
    receiptBatchSize: boundedInteger(
      env.ROBINHOOD_HOLDER_RECEIPT_BATCH_SIZE,
      DEFAULT_RECEIPT_BATCH_SIZE, 1, 100, 'receipt batch size'
    ),
  });
}

module.exports = {
  createConfiguredRobinhoodHolderBackfillExecutor,
  createRobinhoodHolderBackfillExecutor,
  __private: {
    DEFAULT_DRIFT_RECHECK_MS, DEFAULT_RECEIPT_BATCH_SIZE, DEFAULT_RECEIPT_BLOCK_LIMIT,
    REQUIRED_DRIFT_OBSERVATIONS, resolveRpcProvider,
  },
};
