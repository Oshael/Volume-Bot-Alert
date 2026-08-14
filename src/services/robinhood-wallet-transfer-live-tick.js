const {
  CLASSIFICATION_VERSION,
  createRobinhoodTransferClassifier,
} = require('./robinhood-transfer-classifier');

const STREAM = 'live';
const EDGE_KINDS = new Set(['wallet_transfer', 'dex_flow']);

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

function classificationInput(captured, fromTime) {
  const transactionHashes = new Set();
  const endpointAddresses = new Set();
  for (const transfer of captured.transfers) {
    transactionHashes.add(transfer.transactionHash);
    endpointAddresses.add(transfer.fromWallet);
    endpointAddresses.add(transfer.toWallet);
  }
  return {
    fromBlock: captured.fromBlock, toBlock: captured.toBlock,
    fromTime,
    toTime: captured.checkpoint.blockTime,
    transactionHashes: [...transactionHashes], endpointAddresses: [...endpointAddresses],
  };
}

function classifyTransfers(transfers, context, classifierFactory) {
  const classifier = classifierFactory({
    poolAddresses: context.poolAddresses,
    routerAddresses: context.routerAddresses,
    contractAddresses: context.contractAddresses,
    walletAddresses: context.walletAddresses,
  });
  const counts = {};
  const events = transfers.map((transfer) => {
    const decision = classifier.classify(transfer, context);
    counts[decision.kind] = (counts[decision.kind] || 0) + 1;
    return {
      ...transfer, transferKind: decision.kind,
      classificationVersion: decision.classificationVersion,
    };
  });
  return { counts, events };
}

async function initializeCursor(projection, captured, sourceThrough) {
  return projection.initCursor({
    projectionVersion: CLASSIFICATION_VERSION, stream: STREAM,
    nextBlock: captured.fromBlock, nextBlockTime: captured.checkpoint.blockTime,
    safeHead: sourceThrough,
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
    captured.transfers, context, deps.classifierFactory || createRobinhoodTransferClassifier
  );
  const raw = await deps.raw.insertTransferEvents(classified.events);
  const projected = await deps.projection.commitBatch({
    projectionVersion: CLASSIFICATION_VERSION, stream: STREAM,
    expectedVersion: cursor.version, nextBlock: captured.nextBlock,
    nextBlockTime: captured.checkpoint.blockTime, safeHead: sourceThrough,
    checkpointBlock: captured.checkpoint.number, checkpointHash: captured.checkpoint.hash,
    events: classified.events.filter(({ transferKind }) => EDGE_KINDS.has(transferKind)),
  });
  return Object.freeze({
    status: projected.committed ? 'projected' : 'cursor-conflict',
    fromBlock: captured.fromBlock, toBlock: captured.toBlock,
    nextBlock: captured.nextBlock, sourceThrough, scopeTokens: captured.scopeTokens,
    transfers: classified.events.length, classifications: Object.freeze(classified.counts),
    rawInserted: raw.inserted, edgeGroups: projected.edgeGroups || 0,
    evidenceCandidates: projected.evidenceCandidates || 0,
    telemetry: captured.telemetry,
  });
}

module.exports = {
  runRobinhoodWalletTransferLiveTick,
  __private: { classificationInput, rangeFor, validateCursorAgainstSource },
};
