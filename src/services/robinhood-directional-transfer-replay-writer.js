const {
  prepareRobinhoodWalletTransferRange,
} = require('./robinhood-wallet-transfer-backfill-tick');
const { isEdgeEligibleTransfer } = require('./robinhood-wallet-transfer-batch');

const PROJECTION_VERSION = 'rh_transfer_v1';

function earlier(left, right) {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? left : right;
  return Number(left.logIndex) < Number(right.logIndex) ? left : right;
}

function firstDirectionalEvents(events) {
  const first = new Map();
  for (const event of events) {
    if (event.transferKind !== 'wallet_transfer' || !isEdgeEligibleTransfer(event)) continue;
    const key = `${event.tokenAddress}:${event.fromWallet}:${event.toWallet}`;
    first.set(key, first.has(key) ? earlier(first.get(key), event) : event);
  }
  return [...first.values()];
}

function unavailable(outcome) {
  const error = new Error(`directional replay source unavailable: ${outcome.reason || outcome.status}`);
  error.code = 'directional_replay_source_unavailable';
  return error;
}

function createRobinhoodDirectionalTransferReplayWriter(options = {}) {
  const rangeDeps = options.rangeDeps;
  const repository = options.repository;
  const tokenScope = options.tokenScope;
  const prepareRange = options.prepareRange || prepareRobinhoodWalletTransferRange;
  if (typeof repository?.applyEvidence !== 'function') {
    throw new TypeError('directional evidence repository is required');
  }
  if (typeof rangeDeps?.evidence?.matchesCheckpoint !== 'function') {
    throw new TypeError('directional replay checkpoint reader is required');
  }
  if (typeof tokenScope?.listRunTokenAddresses !== 'function') {
    throw new TypeError('directional replay frozen token scope is required');
  }
  const tokenAddressPromises = new Map();
  function tokenAddresses(range, commit) {
    const key = commit ? String(range.runId || '') : 'preflight';
    if (commit && !key) throw new Error('directional replay range has no frozen run scope');
    if (!tokenAddressPromises.has(key)) {
      tokenAddressPromises.set(key, commit
        ? tokenScope.listRunTokenAddresses(key)
        : rangeDeps.source.listTrackedTokenAddresses());
    }
    return tokenAddressPromises.get(key);
  }

  async function load(range, commit) {
    const prepared = await prepareRange(rangeDeps, {
      fromBlock: range.rangeStartBlock, toBlock: range.rangeEndBlock,
      tokenAddresses: await tokenAddresses(range, commit), commit,
    });
    if (prepared.outcome) throw unavailable(prepared.outcome);
    const { captured, classified } = prepared;
    if (captured.fromBlock !== range.rangeStartBlock
      || captured.toBlock !== range.rangeEndBlock
      || captured.checkpoint.number !== range.rangeEndBlock) {
      throw unavailable({ reason: 'range_mismatch' });
    }
    const checkpointCanonical = await rangeDeps.evidence.matchesCheckpoint({
      number: captured.checkpoint.number, hash: captured.checkpoint.hash,
    });
    return {
      captured, checkpointCanonical,
      events: firstDirectionalEvents(classified.events),
    };
  }

  async function probeRange(range) {
    const loaded = await load(range, false);
    const telemetry = loaded.captured.telemetry || {};
    return Object.freeze({
      checkpointCanonical: loaded.checkpointCanonical,
      rpcRequests: Number(telemetry.requests || 0) + Number(telemetry.evidenceBatches || 0),
      transfersScanned: loaded.captured.transfers.length,
      edgesConsidered: loaded.events.length,
    });
  }

  async function materializeRange(range) {
    const loaded = await load(range, true);
    if (!loaded.checkpointCanonical) {
      const error = new Error('directional replay range checkpoint is not canonical');
      error.code = 'directional_replay_checkpoint_mismatch';
      throw error;
    }
    const written = await repository.applyEvidence({
      projectionVersion: PROJECTION_VERSION, events: loaded.events,
    });
    return Object.freeze({
      completedThroughBlock: loaded.captured.checkpoint.number,
      completedThroughHash: loaded.captured.checkpoint.hash,
      blocksScanned: (BigInt(range.rangeEndBlock) - BigInt(range.rangeStartBlock) + 1n).toString(),
      transfersScanned: String(loaded.captured.transfers.length),
      edgesConsidered: String(written.edgesConsidered),
      edgesWritten: String(written.edgesWritten),
    });
  }

  return Object.freeze({ materializeRange, probeRange });
}

module.exports = {
  createRobinhoodDirectionalTransferReplayWriter,
  __private: { firstDirectionalEvents },
};
