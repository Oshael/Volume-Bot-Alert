const db = require('../models/db');
const { createRobinhoodHolderBackfillRepository } = require('../models/robinhood-holder-backfill');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { resolveRobinhoodHolderRpcProvider } = require('./robinhood-holder-rpc');
const { createRobinhoodHolderTransferReader } = require('./robinhood-holder-transfer-reader');

const PROVIDER_NAME = 'robinhood-holder-backfill';
const REQUIRED_DRIFT_OBSERVATIONS = 3;
const DEFAULT_DRIFT_RECHECK_MS = 60_000;

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
  const now = options.now || Date.now;
  const driftRecheckMs = boundedInteger(
    options.driftRecheckMs, DEFAULT_DRIFT_RECHECK_MS, 1000, 600_000, 'driftRecheckMs'
  );
  const driftEvidence = new Map();

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

  async function runOnce(input = {}) {
    const rangeSize = boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize');
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const selectedAtMs = Number(now());
    if (!Number.isFinite(selectedAtMs)) throw new Error('holder backfill clock is invalid');
    const head = await reader.getSafeHead(confirmations);
    const excludeTokenAddresses = [...driftEvidence.entries()]
      .filter(([, evidence]) => evidence.nextObservationAtMs > selectedAtMs)
      .map(([tokenAddress]) => tokenAddress);
    const state = await repository.getNextToken({
      throughBlock: head.safeHead, excludeTokenAddresses,
    });
    if (!state) return Object.freeze({ status: 'idle', safeHead: head.safeHead });
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
      const observedAtMs = Number(now());
      if (!Number.isFinite(observedAtMs)) throw new Error('holder backfill clock is invalid');
      const evidence = observeDrift(committed, state, observedAtMs);
      if (evidence.observations >= REQUIRED_DRIFT_OBSERVATIONS) {
        committed = await repository.commitRange({ ...range, confirmDrift: true });
        driftEvidence.delete(state.tokenAddress);
      } else {
        return Object.freeze({
          ...committed, observations: evidence.observations,
          requiredObservations: REQUIRED_DRIFT_OBSERVATIONS,
          nextObservationAt: new Date(evidence.nextObservationAtMs).toISOString(),
          safeHead: head.safeHead, atBarrier: false,
        });
      }
    } else {
      driftEvidence.delete(state.tokenAddress);
    }
    if (committed.status !== 'committed') {
      return Object.freeze({
        ...committed, observations: REQUIRED_DRIFT_OBSERVATIONS,
        requiredObservations: REQUIRED_DRIFT_OBSERVATIONS,
        safeHead: head.safeHead, atBarrier: false,
      });
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
  return createRobinhoodHolderBackfillExecutor({
    repository, reader,
    driftRecheckMs: boundedInteger(
      env.ROBINHOOD_HOLDER_DRIFT_RECHECK_MS,
      DEFAULT_DRIFT_RECHECK_MS, 1000, 600_000, 'drift recheck interval'
    ),
  });
}

module.exports = {
  createConfiguredRobinhoodHolderBackfillExecutor,
  createRobinhoodHolderBackfillExecutor,
  __private: { DEFAULT_DRIFT_RECHECK_MS, REQUIRED_DRIFT_OBSERVATIONS, resolveRpcProvider },
};
