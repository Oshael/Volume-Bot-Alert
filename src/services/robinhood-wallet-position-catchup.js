const {
  CLASSIFICATION_VERSION,
} = require('./robinhood-wallet-transfer-batch');
const {
  prepareRobinhoodWalletTransferRange,
} = require('./robinhood-wallet-transfer-backfill-tick');
const {
  UNIFIED_POSITION_VERSION,
  buildRobinhoodWalletUnifiedPositionBatch,
  listTouchedWalletPositions,
} = require('./robinhood-wallet-unified-position-batch');

function methods(value, names, label) {
  if (!names.every((name) => typeof value?.[name] === 'function')) {
    throw new TypeError(`${label} is required`);
  }
}

function boundedBlocks(value) {
  const parsed = value == null ? 500 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('maxBlocks must be between 1 and 5000');
  }
  return parsed;
}

function validateCursors(transfer, position) {
  if (!transfer) return 'transfer_seed_missing';
  if (transfer.originBlock == null) return 'transfer_origin_missing';
  if (transfer.safeHead == null) return 'transfer_safe_head_missing';
  if (position?.originBlock == null && position) return 'position_origin_missing';
  if (position && position.originBlock !== transfer.originBlock) return 'origin_mismatch';
  if (position && position.safeHead !== transfer.safeHead) return 'safe_head_mismatch';
  if (position && BigInt(position.nextBlock) > BigInt(transfer.nextBlock)) {
    return 'position_ahead_of_transfers';
  }
  return null;
}

async function runRobinhoodWalletPositionCatchup(deps, input = {}) {
  methods(deps.transferProjection, ['loadCursor'], 'transfer projection');
  methods(deps.positionProjection, [
    'loadCursor', 'initCursor', 'loadPositions', 'readUnifiedRangeSwaps', 'commitBatch',
  ], 'position projection');
  methods(deps.transactionPositions, ['resolveSwaps'], 'transaction-position resolver');
  methods(deps.evidence, ['matchesCheckpoint'], 'transfer evidence reader');
  const transfer = await deps.transferProjection.loadCursor(CLASSIFICATION_VERSION, 'seed');
  let position = await deps.positionProjection.loadCursor(UNIFIED_POSITION_VERSION, 'seed');
  const reason = validateCursors(transfer, position);
  if (reason) return Object.freeze({ status: 'blocked', reason });
  if (transfer.checkpointBlock != null && !await deps.evidence.matchesCheckpoint({
    number: transfer.checkpointBlock, hash: transfer.checkpointHash,
  })) return Object.freeze({ status: 'blocked', reason: 'transfer_checkpoint_mismatch' });

  const fromBlock = position?.nextBlock || transfer.originBlock;
  const targetNextBlock = transfer.nextBlock;
  if (BigInt(fromBlock) === BigInt(targetNextBlock)) {
    return Object.freeze({ status: 'caught-up', reason: null, nextBlock: fromBlock });
  }
  const candidate = BigInt(fromBlock) + BigInt(boundedBlocks(input.maxBlocks)) - 1n;
  const lastAvailable = BigInt(targetNextBlock) - 1n;
  const toBlock = (candidate < lastAvailable ? candidate : lastAvailable).toString();
  const prepared = await prepareRobinhoodWalletTransferRange(deps, {
    fromBlock, toBlock, commit: input.commit === true,
  });
  if (prepared.outcome) return prepared.outcome;
  const swapRows = await deps.positionProjection.readUnifiedRangeSwaps({
    fromBlock, toBlock, fromTime: prepared.captured.fromBlockTime,
    toTime: prepared.captured.checkpoint.blockTime,
    tokenAddresses: prepared.tokenAddresses,
  });
  const resolvedSwaps = await deps.transactionPositions.resolveSwaps(swapRows, {
    commit: input.commit === true,
  });
  const swaps = resolvedSwaps.swaps;
  const pairs = listTouchedWalletPositions(swaps, prepared.classified.events);
  const stored = await deps.positionProjection.loadPositions(UNIFIED_POSITION_VERSION, pairs);
  const batch = buildRobinhoodWalletUnifiedPositionBatch({
    swaps, transfers: prepared.classified.events, positions: stored,
  });
  const nextBlock = prepared.captured.nextBlock;
  const summary = {
    status: input.commit === true ? 'pending-commit' : 'dry-run', reason: null,
    fromBlock, toBlock, nextBlock, targetNextBlock,
    transfers: prepared.classified.events.length, classifications: prepared.classified.counts,
    transactionPositions: resolvedSwaps.telemetry,
    ...batch.telemetry,
  };
  if (input.commit !== true) return Object.freeze(summary);
  if (!position) {
    position = await deps.positionProjection.initCursor({
      projectionVersion: UNIFIED_POSITION_VERSION, stream: 'seed',
      originBlock: transfer.originBlock, nextBlock: transfer.originBlock,
      nextBlockTime: prepared.captured.fromBlockTime, safeHead: transfer.safeHead,
    });
  }
  if (position.nextBlock !== fromBlock || !['pending', 'running'].includes(position.lifecycleState)) {
    return Object.freeze({ ...summary, status: 'cursor-conflict' });
  }
  const persisted = await deps.positionProjection.commitBatch({
    projectionVersion: UNIFIED_POSITION_VERSION, stream: 'seed',
    expectedVersion: position.version, nextBlock,
    nextBlockTime: prepared.captured.checkpoint.blockTime, safeHead: transfer.safeHead,
    checkpointBlock: prepared.captured.checkpoint.number,
    checkpointHash: prepared.captured.checkpoint.hash, positions: batch.positions,
  });
  return Object.freeze({
    ...summary,
    status: persisted.committed
      ? (BigInt(nextBlock) === BigInt(targetNextBlock) ? 'caught-up' : 'projected')
      : 'cursor-conflict',
    persisted,
  });
}

module.exports = { runRobinhoodWalletPositionCatchup, __private: { validateCursors } };
