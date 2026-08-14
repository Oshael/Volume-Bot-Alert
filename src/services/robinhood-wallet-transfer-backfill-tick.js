const { RAW_RETENTION_DAYS } = require('../models/robinhood-token-transfer-persistence');
const {
  CLASSIFICATION_VERSION, EDGE_KINDS, classificationInput, classifyTransfers,
  earliestTransferTime, withEndpointRoles,
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

async function runRobinhoodWalletTransferBackfillDryRun(deps, input = {}) {
  assertDependencies(deps);
  const maxBlocks = boundedInteger(input.maxBlocks, 250, 1, 5000, 'maxBlocks');
  const plan = await deps.source.loadBackfillPlan(CLASSIFICATION_VERSION);
  if (!plan.ready) {
    return Object.freeze({ status: 'blocked', reason: plan.reason, plan });
  }
  if (plan.status === 'complete') {
    return Object.freeze({ status: 'complete', reason: null, plan });
  }
  if (!await checkpointIsCanonical(deps.evidence, plan.seed)) {
    return Object.freeze({ status: 'blocked', reason: 'checkpoint_mismatch', plan });
  }
  const range = rangeForPlan(plan, maxBlocks);
  const tokenAddresses = await deps.source.listTrackedTokenAddresses();
  const captured = await deps.evidence.readRange({ tokenAddresses, ...range });
  const context = await deps.source.loadBackfillRangeContext(classificationInput(
    captured, earliestTransferTime(captured)
  ));
  if (!context.ready) {
    return Object.freeze({ status: 'awaiting-context', reason: context.reason, plan, ...range });
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
  });
}

module.exports = {
  runRobinhoodWalletTransferBackfillDryRun,
  __private: { rangeForPlan, retentionCutoff },
};
