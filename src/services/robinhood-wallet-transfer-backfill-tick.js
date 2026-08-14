const { RAW_RETENTION_DAYS } = require('../models/robinhood-token-transfer-persistence');
const {
  CLASSIFICATION_VERSION, EDGE_KINDS, classificationInput, classifyTransfers,
  withEndpointRoles,
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
  requireMethods(deps.source, [
    'listTrackedTokenAddresses', 'loadBackfillPlan', 'loadBackfillRangeContext',
  ], 'transfer backfill source');
  requireMethods(deps.evidence, ['matchesCheckpoint', 'readRange'], 'transfer evidence reader');
  requireMethods(deps.roles, ['resolveRoles'], 'transfer endpoint role reader');
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
  const { plan, captured, classified, rawEligible, summaryOnly, edgeEligible, cutoff, roles } = prepared;
  return Object.freeze({
    status: 'dry-run', reason: null, plan, fromBlock: captured.fromBlock,
    toBlock: captured.toBlock, nextBlock: captured.nextBlock,
    completesSeed: BigInt(captured.nextBlock) > BigInt(plan.throughBlock),
    scopeTokens: captured.scopeTokens, transfers: classified.events.length,
    classifications: classified.counts, rawEligible: rawEligible.length,
    summaryOnly: summaryOnly.length,
    classificationOnly: classified.events.length - rawEligible.length - summaryOnly.length,
    edgeEligible: edgeEligible.length, rawCutoff: cutoff.toISOString(),
    telemetry: Object.freeze({ ...captured.telemetry, endpointRoles: roles.telemetry }),
    ...additions,
  });
}

async function prepareBackfillRange(deps, input = {}) {
  assertDependencies(deps);
  const maxBlocks = boundedInteger(input.maxBlocks, 250, 1, 5000, 'maxBlocks');
  const plan = await deps.source.loadBackfillPlan(CLASSIFICATION_VERSION);
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
  const tokenAddresses = await deps.source.listTrackedTokenAddresses();
  const captured = await deps.evidence.readRange({ tokenAddresses, ...range });
  const context = await deps.source.loadBackfillRangeContext(classificationInput(
    captured, captured.fromBlockTime
  ));
  if (!context.ready) {
    return { outcome: Object.freeze({
      status: 'awaiting-context', reason: context.reason, plan, ...range,
    }) };
  }
  const roles = await deps.roles.resolveRoles({
    transfers: captured.transfers,
    poolAddresses: context.poolAddresses,
    routerAddresses: context.routerAddresses,
    contractAddresses: context.contractAddresses,
    walletAddresses: context.walletAddresses,
  });
  const classified = classifyTransfers(
    captured.transfers, withEndpointRoles(context, roles), deps.classifierFactory
  );
  const cutoff = retentionCutoff(input.now);
  const isRawEligible = (event) => new Date(event.blockTime) >= cutoff;
  const rawEligible = classified.events.filter(isRawEligible);
  const edgeEligible = classified.events.filter(({ transferKind }) => EDGE_KINDS.has(transferKind));
  const summaryOnly = edgeEligible.filter((event) => !isRawEligible(event));
  return { plan, captured, classified, rawEligible, edgeEligible, summaryOnly, cutoff, roles };
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
  const prepared = await prepareBackfillRange(deps, input);
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
  runRobinhoodWalletTransferBackfillCommit,
  runRobinhoodWalletTransferBackfillDryRun,
  __private: { rangeForPlan, retentionCutoff, summarizeThroughDay },
};
