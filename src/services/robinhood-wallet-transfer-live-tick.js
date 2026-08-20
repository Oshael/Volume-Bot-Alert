const {
  CLASSIFICATION_VERSION, classificationInput, classifyTransfers, isEdgeEligibleTransfer,
} = require('./robinhood-wallet-transfer-batch');
const {
  UNIFIED_POSITION_VERSION,
  buildRobinhoodWalletUnifiedPositionBatch,
  listTouchedWalletPositions,
} = require('./robinhood-wallet-unified-position-batch');

const STREAM = 'live';

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requireMethods(value, names, label) {
  if (!names.every((name) => typeof value?.[name] === 'function')) {
    throw new TypeError(`${label} is required`);
  }
}

function assertDependencies(deps) {
  requireMethods(deps.source, [
    'listTrackedTokenAddresses', 'loadRangeContext', 'loadSwapFrontier',
  ], 'transfer LIVE source');
  requireMethods(deps.evidence, ['matchesCheckpoint', 'readRange'], 'transfer evidence reader');
  requireMethods(deps.projection, ['commitBatch', 'initCursor', 'loadCursor'], 'transfer projection');
  requireMethods(deps.raw, ['insertTransferEvents'], 'raw transfer repository');
}

function assertPositionDependencies(positions) {
  requireMethods(positions, [
    'loadCursor', 'initCursor', 'loadPositions', 'readUnifiedRangeSwaps',
  ], 'unified position projection');
}

function assertTransactionPositionDependencies(transactionPositions) {
  requireMethods(transactionPositions, ['resolveSwaps'], 'transaction-position resolver');
}

function sourceRegression(message) {
  return Object.assign(new Error(message), { code: 'transfer_source_frontier_regressed' });
}

function validateCursorAgainstSource(cursor, sourceThrough) {
  if (!cursor) return;
  if (!['pending', 'running'].includes(cursor.lifecycleState)) {
    throw sourceRegression(`transfer LIVE cursor is ${cursor.lifecycleState}`);
  }
  if (BigInt(cursor.nextBlock) > BigInt(sourceThrough) + 1n) {
    throw sourceRegression('transfer LIVE cursor is ahead of its durable source');
  }
  if (cursor.safeHead != null && BigInt(cursor.safeHead) > BigInt(sourceThrough)) {
    throw sourceRegression('transfer LIVE safe head is ahead of its durable source');
  }
}

async function checkpointIsCanonical(evidence, cursor) {
  if (cursor?.checkpointBlock == null) return true;
  return evidence.matchesCheckpoint({
    number: cursor.checkpointBlock, hash: cursor.checkpointHash,
  });
}

function rangeFor(cursor, sourceThrough, maxBlocks) {
  const fromBlock = cursor ? BigInt(cursor.nextBlock) : BigInt(sourceThrough);
  const candidateEnd = fromBlock + BigInt(maxBlocks - 1);
  return {
    fromBlock: fromBlock.toString(),
    toBlock: (cursor && candidateEnd < BigInt(sourceThrough)
      ? candidateEnd : BigInt(sourceThrough)).toString(),
  };
}

async function initializeCursor(projection, captured, sourceThrough) {
  return projection.initCursor({
    projectionVersion: CLASSIFICATION_VERSION, stream: STREAM,
    nextBlock: captured.fromBlock, nextBlockTime: captured.checkpoint.blockTime,
    safeHead: sourceThrough,
  });
}

function positionWait(reason, transfer, position = null) {
  return Object.freeze({
    status: 'awaiting-position-catch-up', reason,
    transferNextBlock: transfer.nextBlock,
    positionNextBlock: position?.nextBlock || null,
  });
}

async function prepareUnifiedPosition(deps, input) {
  if (input.enabled !== true) return Object.freeze({ batch: null, telemetry: null });
  assertPositionDependencies(deps.positions);
  const seed = await deps.positions.loadCursor(UNIFIED_POSITION_VERSION, 'seed');
  if (!seed || seed.lifecycleState !== 'complete') {
    return { outcome: positionWait('position_seed_incomplete', input.transfer, seed) };
  }
  if (seed.nextBlock !== input.transfer.originBlock) {
    return { outcome: positionWait('position_seed_handoff_mismatch', input.transfer, seed) };
  }
  let live = await deps.positions.loadCursor(UNIFIED_POSITION_VERSION, STREAM);
  if (!live) {
    if (input.transfer.nextBlock !== seed.nextBlock) {
      return { outcome: positionWait('position_live_missing', input.transfer) };
    }
    live = await deps.positions.initCursor({
      projectionVersion: UNIFIED_POSITION_VERSION,
      stream: STREAM,
      originBlock: seed.nextBlock,
      nextBlock: seed.nextBlock,
      nextBlockTime: seed.nextBlockTime,
      safeHead: input.sourceThrough,
    });
  }
  if (!['pending', 'running'].includes(live.lifecycleState)) {
    return { outcome: positionWait('position_live_not_running', input.transfer, live) };
  }
  if (live.originBlock !== seed.nextBlock) {
    return { outcome: positionWait('position_live_origin_mismatch', input.transfer, live) };
  }
  if (BigInt(live.nextBlock) < BigInt(input.transfer.nextBlock)) {
    return { outcome: positionWait('position_live_behind', input.transfer, live) };
  }
  if (BigInt(live.nextBlock) > BigInt(input.transfer.nextBlock)) {
    throw sourceRegression('unified position LIVE cursor is ahead of transfers');
  }
  assertTransactionPositionDependencies(deps.transactionPositions);
  const swapRows = await deps.positions.readUnifiedRangeSwaps({
    fromBlock: input.captured.fromBlock,
    toBlock: input.captured.toBlock,
    fromTime: input.fromTime,
    toTime: input.captured.checkpoint.blockTime,
    tokenAddresses: input.tokenAddresses,
  });
  const resolvedSwaps = await deps.transactionPositions.resolveSwaps(swapRows, { commit: true });
  const swaps = resolvedSwaps.swaps;
  const pairs = listTouchedWalletPositions(swaps, input.transfers);
  const stored = await deps.positions.loadPositions(UNIFIED_POSITION_VERSION, pairs);
  const projected = buildRobinhoodWalletUnifiedPositionBatch({
    swaps, transfers: input.transfers, positions: stored,
  });
  return Object.freeze({
    batch: Object.freeze({
      projectionVersion: UNIFIED_POSITION_VERSION,
      stream: STREAM,
      expectedVersion: live.version,
      nextBlock: input.captured.nextBlock,
      nextBlockTime: input.captured.checkpoint.blockTime,
      safeHead: input.sourceThrough,
      checkpointBlock: input.captured.checkpoint.number,
      checkpointHash: input.captured.checkpoint.hash,
      positions: projected.positions,
    }),
    telemetry: Object.freeze({
      ...projected.telemetry,
      transactionPositions: resolvedSwaps.telemetry,
    }),
  });
}

async function runRobinhoodWalletTransferLiveTick(deps, input = {}) {
  assertDependencies(deps);
  const maxBlocks = boundedInteger(input.maxBlocks, 25, 1, 250, 'maxBlocks');
  const frontier = await deps.source.loadSwapFrontier();
  if (!frontier.ready) {
    return Object.freeze({ status: 'awaiting-source', reason: frontier.reason });
  }
  const sourceThrough = frontier.completeThroughBlock;
  let cursor = await deps.projection.loadCursor(CLASSIFICATION_VERSION, STREAM);
  validateCursorAgainstSource(cursor, sourceThrough);
  if (!await checkpointIsCanonical(deps.evidence, cursor)) {
    return Object.freeze({ status: 'blocked', reason: 'checkpoint_mismatch' });
  }
  if (cursor && BigInt(cursor.nextBlock) > BigInt(sourceThrough)) {
    return Object.freeze({ status: 'caught-up', nextBlock: cursor.nextBlock, sourceThrough });
  }
  const range = rangeFor(cursor, sourceThrough, maxBlocks);
  const tokenAddresses = await deps.source.listTrackedTokenAddresses();
  const captured = await deps.evidence.readRange({ tokenAddresses, ...range });
  const fromTime = cursor?.nextBlockTime || captured.checkpoint.blockTime;
  if (!cursor) {
    cursor = await initializeCursor(deps.projection, captured, sourceThrough);
    if (cursor.nextBlock !== captured.fromBlock) {
      return Object.freeze({ status: 'cursor-conflict', sourceThrough });
    }
  }
  const context = await deps.source.loadRangeContext(classificationInput(captured, fromTime));
  if (!context.ready) {
    return Object.freeze({
      status: 'awaiting-context', reason: context.reason,
      completeThroughBlock: context.completeThroughBlock || null,
    });
  }
  const classified = classifyTransfers(
    captured.transfers, context, deps.classifierFactory
  );
  const unified = await prepareUnifiedPosition(deps, {
    enabled: input.unifiedPositionEnabled,
    transfer: cursor,
    sourceThrough,
    captured,
    fromTime,
    tokenAddresses,
    transfers: classified.events,
  });
  if (unified.outcome) return unified.outcome;
  const raw = await deps.raw.insertTransferEvents(classified.events);
  const projected = await deps.projection.commitBatch({
    projectionVersion: CLASSIFICATION_VERSION, stream: STREAM,
    expectedVersion: cursor.version, nextBlock: captured.nextBlock,
    nextBlockTime: captured.checkpoint.blockTime, safeHead: sourceThrough,
    checkpointBlock: captured.checkpoint.number, checkpointHash: captured.checkpoint.hash,
    events: classified.events.filter(isEdgeEligibleTransfer),
    ...(unified.batch ? { positionBatch: unified.batch } : {}),
  });
  return Object.freeze({
    status: projected.committed ? 'projected' : 'cursor-conflict',
    fromBlock: captured.fromBlock, toBlock: captured.toBlock,
    nextBlock: captured.nextBlock, sourceThrough, scopeTokens: captured.scopeTokens,
    transfers: classified.events.length, classifications: Object.freeze(classified.counts),
    rawInserted: raw.inserted, edgeGroups: projected.edgeGroups || 0,
    evidenceCandidates: projected.evidenceCandidates || 0,
    unifiedPosition: unified.telemetry,
    telemetry: Object.freeze({
      ...captured.telemetry, endpointRoles: context.endpointRoleCoverage,
    }),
  });
}

module.exports = {
  runRobinhoodWalletTransferLiveTick,
  __private: {
    classificationInput, prepareUnifiedPosition, rangeFor, validateCursorAgainstSource,
  },
};
