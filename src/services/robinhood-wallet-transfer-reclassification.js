const {
  CLASSIFICATION_VERSION,
  createRobinhoodTransferClassifier,
} = require('./robinhood-transfer-classifier');

const TRANSITION_VERSION = 'rh_transfer_reclass_v1';

function requireMethods(value, methods, label) {
  if (!methods.every((method) => typeof value?.[method] === 'function')) {
    throw new TypeError(`${label} is required`);
  }
}

function classificationInput(candidates) {
  const blocks = candidates.map(({ blockNumber }) => BigInt(blockNumber));
  const times = candidates.map(({ blockTime }) => blockTime).sort();
  return {
    fromBlock: blocks.reduce((left, right) => left < right ? left : right).toString(),
    toBlock: blocks.reduce((left, right) => left > right ? left : right).toString(),
    fromTime: times[0], toTime: times[times.length - 1],
    transactionHashes: [...new Set(candidates.map(({ transactionHash }) => transactionHash))],
    endpointAddresses: [...new Set(candidates.flatMap(({ fromWallet, toWallet }) => (
      [fromWallet, toWallet]
    )))],
  };
}

function prepareAction(candidate, classifier, context) {
  const decision = classifier.classify(candidate, context);
  if (decision.kind === 'unknown') return { skipped: decision.reasonCode };
  if (candidate.fromWallet === candidate.toWallet) {
    return { skipped: 'wallet_self_transfer_unsupported' };
  }
  return {
    transition: {
      transactionHash: candidate.transactionHash, logIndex: candidate.logIndex,
      blockTime: candidate.blockTime,
      fromClassificationVersion: candidate.classificationVersion,
      toTransferKind: decision.kind, toClassificationVersion: decision.classificationVersion,
      transitionVersion: TRANSITION_VERSION, decisionReason: decision.reasonCode,
      decisionEvidence: {
        fromEndpoint: candidate.fromRoleEvidence, toEndpoint: candidate.toRoleEvidence,
        matchedSwap: decision.matchedSwap,
      },
    },
  };
}

function summary(day, candidates, actions, skippedReasons, classifications) {
  return {
    day, candidates: candidates.length, actionable: actions.length,
    skipped: candidates.length - actions.length,
    firstBlock: candidates[0].blockNumber,
    lastBlock: candidates[candidates.length - 1].blockNumber,
    skippedReasons: Object.freeze(skippedReasons),
    classifications: Object.freeze(classifications),
  };
}

async function runRobinhoodWalletTransferReclassification(deps, input = {}) {
  requireMethods(deps.repository, ['applyTransition', 'listCandidates'], 'reclassification repository');
  requireMethods(deps.source, ['loadBackfillRangeContext'], 'transfer classification source');
  const candidates = await deps.repository.listCandidates({
    classificationVersion: CLASSIFICATION_VERSION, day: input.day, limit: input.limit,
  });
  if (!candidates.length) {
    return Object.freeze({ status: 'caught-up', day: input.day, candidates: 0, actionable: 0 });
  }
  const context = await deps.source.loadBackfillRangeContext(classificationInput(candidates));
  if (!context.ready) {
    return Object.freeze({
      status: 'blocked', reason: context.reason, day: input.day, candidates: candidates.length,
    });
  }
  const classifier = (deps.classifierFactory || createRobinhoodTransferClassifier)({
    poolAddresses: context.poolAddresses, routerAddresses: context.routerAddresses,
    contractAddresses: context.contractAddresses, walletAddresses: context.walletAddresses,
  });
  const prepared = candidates.map((item) => prepareAction(item, classifier, context));
  const actions = prepared.filter(({ transition }) => transition);
  const classifications = {};
  const skippedReasons = {};
  for (const { transition } of actions) {
    classifications[transition.toTransferKind] = (classifications[transition.toTransferKind] || 0) + 1;
  }
  for (const { skipped } of prepared.filter((item) => item.skipped)) {
    skippedReasons[skipped] = (skippedReasons[skipped] || 0) + 1;
  }
  const report = summary(input.day, candidates, actions, skippedReasons, classifications);
  if (input.commit !== true) return Object.freeze({ status: 'dry-run', ...report });
  const outcomes = { applied: 0, alreadyApplied: 0, conflicts: 0, notFound: 0 };
  for (const { transition } of actions) {
    const result = await deps.repository.applyTransition(transition);
    if (result.applied) outcomes.applied += 1;
    else if (result.reason === 'already_applied') outcomes.alreadyApplied += 1;
    else if (result.reason === 'event_not_found') outcomes.notFound += 1;
    else outcomes.conflicts += 1;
  }
  return Object.freeze({ status: 'confirmed', ...report, outcomes: Object.freeze(outcomes) });
}

module.exports = {
  TRANSITION_VERSION,
  runRobinhoodWalletTransferReclassification,
  __private: { classificationInput, prepareAction },
};
