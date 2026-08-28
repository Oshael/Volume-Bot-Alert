const { RAW_RETENTION_DAYS } = require('../models/robinhood-token-transfer-persistence');
const {
  CLASSIFICATION_VERSION, classificationInput, classifyTransfers, isEdgeEligibleTransfer,
} = require('./robinhood-wallet-transfer-batch');

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
  assertRangeDependencies(deps);
  requireMethods(deps.source, ['loadBackfillPlan'], 'transfer backfill source');
  requireMethods(deps.evidence, ['matchesCheckpoint'], 'transfer evidence reader');
}

function assertRangeDependencies(deps) {
  requireMethods(deps.source, [
    'listTrackedTokenAddresses', 'loadBackfillRangeContext',
  ], 'transfer backfill source');
  requireMethods(deps.evidence, ['readRange'], 'transfer evidence reader');
  requireMethods(deps.endpointRoles, ['hydrate'], 'archive endpoint role hydrator');
}

function rangeForPlan(plan, maxBlocks) {
  const fromBlock = BigInt(plan.nextBlock);
  const throughBlock = BigInt(plan.throughBlock);
  const candidate = fromBlock + BigInt(maxBlocks - 1);
  return {
    fromBlock: fromBlock.toString(),
    toBlock: (candidate < throughBlock ? candidate : throughBlock).toString(),
  };
}

function retentionCutoff(nowInput) {
  const now = nowInput instanceof Date ? new Date(nowInput) : new Date(nowInput ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('now must be a valid timestamp');
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - RAW_RETENTION_DAYS
  ));
}

async function checkpointIsCanonical(evidence, seed) {
  if (seed?.checkpointBlock == null) return true;
  return evidence.matchesCheckpoint({ number: seed.checkpointBlock, hash: seed.checkpointHash });
}

function summarizeThroughDay(fromTime, checkpointTime) {
  const fromDay = String(fromTime).slice(0, 10);
  const checkpointDay = String(checkpointTime).slice(0, 10);
  if (fromDay >= checkpointDay) return null;
  const boundary = new Date(`${checkpointDay}T00:00:00.000Z`);
  boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary.toISOString().slice(0, 10);
}

function report(prepared, additions = {}) {
  if (prepared.outcome) return prepared.outcome;
  const {
    plan, captured, classified, rawEligible, summaryOnly, edgeEligible, cutoff, context, hydration,
  } = prepared;
  return Object.freeze({
    status: 'dry-run', reason: null, plan, fromBlock: captured.fromBlock,
    toBlock: captured.toBlock, nextBlock: captured.nextBlock,
    completesSeed: BigInt(captured.nextBlock) > BigInt(plan.throughBlock),
    scopeTokens: captured.scopeTokens, transfers: classified.events.length,
    classifications: classified.counts, rawEligible: rawEligible.length,
    summaryOnly: summaryOnly.length,
    classificationOnly: classified.events.length - rawEligible.length - summaryOnly.length,
    edgeEligible: edgeEligible.length, rawCutoff: cutoff.toISOString(),
    telemetry: Object.freeze({
      ...captured.telemetry,
      endpointRoles: Object.freeze({ ...context.endpointRoleCoverage, hydration }),
    }),
    ...additions,
  });
}

function mergeHydratedRoles(context, hydration) {
  const contracts = new Set([
    ...context.contractAddresses, ...hydration.contractAddresses,
  ]);
  const wallets = new Set([
    ...context.walletAddresses, ...hydration.walletAddresses,
  ]);
  for (const address of contracts) wallets.delete(address);
  return Object.freeze({
    ...context,
    contractAddresses: Object.freeze([...contracts].sort()),
    walletAddresses: Object.freeze([...wallets].sort()),
  });
}

function knownContextAddresses(context) {
  return [...new Set([
    ...(context.rpcExemptAddresses || []),
    ...(context.contractAddresses || []),
    ...(context.walletAddresses || []),
  ])];
}

async function prepareRobinhoodWalletTransferRange(deps, input = {}) {
  assertRangeDependencies(deps);
  const tokenAddresses = input.tokenAddresses
    || await deps.source.listTrackedTokenAddresses();
  const captured = await deps.evidence.readRange({
    tokenAddresses, fromBlock: input.fromBlock, toBlock: input.toBlock,
    forceAddressFiltered: input.forceAddressFiltered === true,
  });
  const baseContext = await deps.source.loadBackfillRangeContext(classificationInput(
    captured, captured.fromBlockTime
  ));
  if (!baseContext.ready) {
    return { outcome: Object.freeze({
      status: 'awaiting-context', reason: baseContext.reason,
      fromBlock: captured.fromBlock, toBlock: captured.toBlock,
    }) };
  }
  const hydration = await deps.endpointRoles.hydrate({
    transfers: captured.transfers, commit: input.commit === true,
    knownAddresses: knownContextAddresses(baseContext),
  });
  const context = mergeHydratedRoles(baseContext, hydration);
  const classified = classifyTransfers(
    captured.transfers, context, deps.classifierFactory
  );
  return { tokenAddresses, captured, classified, context, hydration };
}

function combineCapturedRanges(capturedRanges) {
  if (!Array.isArray(capturedRanges) || !capturedRanges.length) {
    throw new TypeError('capturedRanges must be a non-empty list');
  }
  const first = capturedRanges[0];
  const last = capturedRanges[capturedRanges.length - 1];
  return Object.freeze({
    fromBlock: first.fromBlock,
    fromBlockTime: first.fromBlockTime,
    toBlock: last.toBlock,
    checkpoint: last.checkpoint,
    transfers: Object.freeze(capturedRanges.flatMap(({ transfers }) => transfers)),
  });
}

async function prepareRobinhoodWalletTransferRanges(deps, input = {}) {
  assertRangeDependencies(deps);
  if (!Array.isArray(input.ranges) || !input.ranges.length) {
    throw new TypeError('ranges must be a non-empty list');
  }
  const tokenAddresses = input.tokenAddresses
    || await deps.source.listTrackedTokenAddresses();
  const capturedRanges = await Promise.all(input.ranges.map((range) => (
    deps.evidence.readRange({
      tokenAddresses, fromBlock: range.fromBlock, toBlock: range.toBlock,
      forceAddressFiltered: input.forceAddressFiltered === true,
    })
  )));
  const captured = combineCapturedRanges(capturedRanges);
  const baseContext = await deps.source.loadBackfillRangeContext(classificationInput(
    captured, captured.fromBlockTime
  ));
  if (!baseContext.ready) {
    return { outcome: Object.freeze({
      status: 'awaiting-context', reason: baseContext.reason,
      fromBlock: captured.fromBlock, toBlock: captured.toBlock,
    }) };
  }
  const hydration = await deps.endpointRoles.hydrate({
    transfers: captured.transfers, commit: input.commit === true,
    knownAddresses: knownContextAddresses(baseContext),
  });
  const context = mergeHydratedRoles(baseContext, hydration);
  const classified = classifyTransfers(
    captured.transfers, context, deps.classifierFactory
  );
  return {
    tokenAddresses, captured, capturedRanges: Object.freeze(capturedRanges),
    classified, context, hydrations: Object.freeze([hydration]),
  };
}

async function prepareBackfillRange(deps, input = {}) {
  assertDependencies(deps);
  const maxBlocks = boundedInteger(input.maxBlocks, 250, 1, 5000, 'maxBlocks');
  const [plan, tokenAddresses] = await Promise.all([
    deps.source.loadBackfillPlan(CLASSIFICATION_VERSION),
    input.tokenAddresses || deps.source.listTrackedTokenAddresses(),
  ]);
  if (!plan.ready) {
    return { outcome: Object.freeze({ status: 'blocked', reason: plan.reason, plan }) };
  }
  if (plan.status === 'complete') {
    return { outcome: Object.freeze({ status: 'complete', reason: null, plan }) };
  }
  if (!await checkpointIsCanonical(deps.evidence, plan.seed)) {
    return { outcome: Object.freeze({ status: 'blocked', reason: 'checkpoint_mismatch', plan }) };
  }
  const range = rangeForPlan(plan, maxBlocks);
  const preparedRange = await prepareRobinhoodWalletTransferRange(deps, {
    ...range, commit: input.commit, tokenAddresses,
  });
  if (preparedRange.outcome) {
    return { outcome: Object.freeze({
      ...preparedRange.outcome, plan, ...range,
    }) };
  }
  const { captured, classified, context, hydration } = preparedRange;
  const cutoff = retentionCutoff(input.now);
  const isRawEligible = (event) => new Date(event.blockTime) >= cutoff;
  const rawEligible = classified.events.filter(isRawEligible);
  const edgeEligible = classified.events.filter(isEdgeEligibleTransfer);
  const summaryOnly = edgeEligible.filter((event) => !isRawEligible(event));
  return {
    plan, captured, classified, rawEligible, edgeEligible, summaryOnly, cutoff, context, hydration,
  };
}

async function runRobinhoodWalletTransferBackfillDryRun(deps, input = {}) {
  return report(await prepareBackfillRange(deps, input));
}

function cursorMatchesRange(cursor, prepared) {
  return cursor?.stream === 'seed'
    && cursor.originBlock === prepared.plan.fromBlock
    && cursor.safeHead === prepared.plan.throughBlock
    && cursor.nextBlock === prepared.captured.fromBlock
    && ['pending', 'running'].includes(cursor.lifecycleState);
}

async function seedCursor(projection, prepared) {
  if (prepared.plan.seed) return prepared.plan.seed;
  return projection.initCursor({
    projectionVersion: CLASSIFICATION_VERSION, stream: 'seed',
    originBlock: prepared.plan.fromBlock, nextBlock: prepared.plan.fromBlock,
    nextBlockTime: prepared.captured.fromBlockTime, safeHead: prepared.plan.throughBlock,
  });
}

async function runRobinhoodWalletTransferBackfillCommit(deps, input = {}) {
  requireMethods(deps.projection, ['commitBatch', 'initCursor'], 'transfer projection');
  requireMethods(deps.raw, ['insertTransferEvents'], 'raw transfer repository');
  const prepared = await prepareBackfillRange(deps, { ...input, commit: true });
  if (prepared.outcome) return prepared.outcome;
  const cursor = await seedCursor(deps.projection, prepared);
  if (!cursorMatchesRange(cursor, prepared)) {
    return report(prepared, { status: 'cursor-conflict', rawInserted: 0 });
  }
  const raw = await deps.raw.insertTransferEvents(prepared.rawEligible);
  const projected = await deps.projection.commitBatch({
    projectionVersion: CLASSIFICATION_VERSION, stream: 'seed',
    expectedVersion: cursor.version, nextBlock: prepared.captured.nextBlock,
    nextBlockTime: prepared.captured.checkpoint.blockTime,
    safeHead: prepared.plan.throughBlock,
    checkpointBlock: prepared.captured.checkpoint.number,
    checkpointHash: prepared.captured.checkpoint.hash,
    summarizedThroughDay: summarizeThroughDay(
      cursor.nextBlockTime, prepared.captured.checkpoint.blockTime
    ),
    events: prepared.edgeEligible,
  });
  return report(prepared, {
    status: projected.committed
      ? (projected.cursor.lifecycleState === 'complete' ? 'complete' : 'projected')
      : 'cursor-conflict',
    rawInserted: raw.inserted, edgeGroups: projected.edgeGroups || 0,
    evidenceCandidates: projected.evidenceCandidates || 0,
  });
}

module.exports = {
  prepareRobinhoodWalletTransferRange, prepareRobinhoodWalletTransferRanges,
  runRobinhoodWalletTransferBackfillCommit,
  runRobinhoodWalletTransferBackfillDryRun,
  __private: {
    combineCapturedRanges, knownContextAddresses, mergeHydratedRoles,
    rangeForPlan, retentionCutoff, summarizeThroughDay,
  },
};
