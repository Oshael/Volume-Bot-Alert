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

function catchupStream(value) {
  const stream = String(value || 'seed').trim().toLowerCase();
  if (!['seed', 'live'].includes(stream)) throw new Error('stream must be seed or live');
  return stream;
}

function validateCommonCursors(transfer, position, stream) {
  if (!transfer) return `transfer_${stream}_missing`;
  if (transfer.originBlock == null) return 'transfer_origin_missing';
  if (transfer.safeHead == null) return 'transfer_safe_head_missing';
  if (position?.originBlock == null && position) return 'position_origin_missing';
  if (position && position.originBlock !== transfer.originBlock) return 'origin_mismatch';
  if (position && BigInt(position.nextBlock) > BigInt(transfer.nextBlock)) {
    return 'position_ahead_of_transfers';
  }
  return null;
}

function validateLiveHandoff(transfer, position, seed) {
  if (!seed) return 'position_seed_missing';
  if (seed.lifecycleState !== 'complete') return 'position_seed_incomplete';
  if (seed.nextBlock !== transfer.originBlock) return 'seed_live_handoff_mismatch';
  if (position?.safeHead != null && BigInt(position.safeHead) > BigInt(transfer.safeHead)) {
    return 'position_safe_head_ahead';
  }
  return null;
}

function validateCursors(transfer, position, stream, seed) {
  const common = validateCommonCursors(transfer, position, stream);
  if (common) return common;
  if (stream === 'live') return validateLiveHandoff(transfer, position, seed);
  return position && position.safeHead !== transfer.safeHead ? 'safe_head_mismatch' : null;
}

async function runRobinhoodWalletPositionCatchup(deps, input = {}) {
  methods(deps.transferProjection, ['loadCursor'], 'transfer projection');
  methods(deps.positionProjection, [
    'loadCursor', 'initCursor', 'loadPositions', 'readUnifiedRangeSwaps', 'commitBatch',
  ], 'position projection');
  methods(deps.transactionPositions, ['resolveSwaps'], 'transaction-position resolver');
  methods(deps.evidence, ['matchesCheckpoint'], 'transfer evidence reader');
  const stream = catchupStream(input.stream);
  const [transfer, existingPosition, seed] = await Promise.all([
    deps.transferProjection.loadCursor(CLASSIFICATION_VERSION, stream),
    deps.positionProjection.loadCursor(UNIFIED_POSITION_VERSION, stream),
    stream === 'live'
      ? deps.positionProjection.loadCursor(UNIFIED_POSITION_VERSION, 'seed')
      : Promise.resolve(null),
  ]);
  let position = existingPosition;
  const reason = validateCursors(transfer, position, stream, seed);
  if (reason) return Object.freeze({ status: 'blocked', reason });
  if (transfer.checkpointBlock != null && !await deps.evidence.matchesCheckpoint({
    number: transfer.checkpointBlock, hash: transfer.checkpointHash,
  })) return Object.freeze({ status: 'blocked', reason: 'transfer_checkpoint_mismatch' });

  const fromBlock = position?.nextBlock || transfer.originBlock;
  const targetNextBlock = transfer.nextBlock;
  if (BigInt(fromBlock) === BigInt(targetNextBlock)) {
    return Object.freeze({ status: 'caught-up', reason: null, stream, nextBlock: fromBlock });
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
    status: input.commit === true ? 'pending-commit' : 'dry-run', reason: null, stream,
    fromBlock, toBlock, nextBlock, targetNextBlock,
    transfers: prepared.classified.events.length, classifications: prepared.classified.counts,
    transactionPositions: resolvedSwaps.telemetry,
    ...batch.telemetry,
  };
  if (input.commit !== true) return Object.freeze(summary);
  if (!position) {
    position = await deps.positionProjection.initCursor({
      projectionVersion: UNIFIED_POSITION_VERSION, stream,
      originBlock: transfer.originBlock, nextBlock: transfer.originBlock,
      nextBlockTime: prepared.captured.fromBlockTime, safeHead: transfer.safeHead,
    });
  }
  if (position.nextBlock !== fromBlock || !['pending', 'running'].includes(position.lifecycleState)) {
    return Object.freeze({ ...summary, status: 'cursor-conflict' });
  }
  const persisted = await deps.positionProjection.commitBatch({
    projectionVersion: UNIFIED_POSITION_VERSION, stream,
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

module.exports = {
  runRobinhoodWalletPositionCatchup,
  __private: { catchupStream, validateCursors },
};
