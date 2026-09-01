const {
  inferPriorSignedActivity, isSafeSignedOriginUnavailableReason,
} = require('./robinhood-wallet-signed-origin-domain');
const {
  compareRobinhoodFreshWalletEvidence, evaluateRobinhoodFreshWallet,
} = require('./robinhood-fresh-wallet-rule');

const MAX_DETAILS = 20;

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function liveEvidence(archive, inference) {
  const { nonce: _nonce, ...cutoff } = archive.cutoff;
  return Object.freeze({ ...archive, sourceKind: 'live', cutoff,
    signedActivity: Object.freeze({
      priorSignedActivity: inference.priorSignedActivity, reason: inference.reason,
    }),
  });
}

function auditCandidate(candidate, archive, origin, coverage) {
  const inference = inferPriorSignedActivity({ cutoffBlock: archive.cutoff.number,
    coverage, firstBuy: { blockNumber: candidate.blockNumber,
      transactionIndex: candidate.transactionIndex },
    signedOrigin: origin && { blockNumber: origin.blockNumber,
      transactionIndex: origin.transactionIndex, nonce: origin.nonce },
  });
  if (inference.status !== 'ready') {
    const safe = isSafeSignedOriginUnavailableReason(inference.reason);
    const archiveOutcome = evaluateRobinhoodFreshWallet(archive).outcome;
    const failClosedEquivalent = safe && archiveOutcome === 'not_fresh';
    return { kind: safe ? 'safeUnavailable' : 'blockingUnavailable',
      behaviorKind: failClosedEquivalent ? 'failClosedEquivalent'
        : safe ? 'freshUnavailable' : null,
      detail: { tokenAddress: candidate.tokenAddress, walletAddress: candidate.walletAddress,
        status: failClosedEquivalent ? 'fail_closed_equivalent'
          : safe ? 'safe_unavailable' : 'unavailable',
        reason: inference.reason, archiveOutcome } };
  }
  const comparison = compareRobinhoodFreshWalletEvidence(archive,
    liveEvidence(archive, inference));
  return comparison.equivalent ? { kind: 'equivalent' } : { kind: 'mismatched',
    detail: { tokenAddress: candidate.tokenAddress, walletAddress: candidate.walletAddress,
      status: 'mismatched', ...comparison } };
}

function assertDependencies(repository, archiveSource) {
  const methods = [repository?.loadCoverage, repository?.sampleCandidates,
    repository?.loadOrigins, archiveSource?.readEvidenceBatch];
  if (methods.some((method) => typeof method !== 'function')) {
    throw new TypeError('FRESH signed-origin audit dependencies are incomplete');
  }
}

async function runRobinhoodFreshWalletSignedOriginAudit(deps = {}, options = {}) {
  const { repository, archiveSource } = deps;
  assertDependencies(repository, archiveSource);
  const sampleCount = bounded(options.sampleCount, 500, 1, 5000, 'sampleCount');
  const minimumSamples = bounded(options.minimumSamples, 100, 1, sampleCount,
    'minimumSamples');
  const batchSize = bounded(options.batchSize, 100, 1, 100, 'batchSize');
  const maxFreshUnavailableBps = bounded(options.maxFreshUnavailableBps, 100, 0, 10_000,
    'maxFreshUnavailableBps');
  const coverage = await repository.loadCoverage();
  const candidates = await repository.sampleCandidates(sampleCount);
  const counts = { equivalent: 0, mismatched: 0, safeUnavailable: 0,
    blockingUnavailable: 0, failClosedEquivalent: 0, freshUnavailable: 0 };
  const details = [];
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const [archives, origins] = await Promise.all([
      archiveSource.readEvidenceBatch(batch),
      repository.loadOrigins(batch.map(({ walletAddress }) => walletAddress)),
    ]);
    if (!Array.isArray(archives) || archives.length !== batch.length) {
      throw new Error('Archive returned an incomplete FRESH audit batch');
    }
    batch.forEach((candidate, index) => {
      const result = auditCandidate(candidate, archives[index],
        origins.get(candidate.walletAddress), coverage);
      counts[result.kind] += 1;
      if (result.behaviorKind) counts[result.behaviorKind] += 1;
      if (result.detail && details.length < MAX_DETAILS) details.push(result.detail);
    });
    options.onProgress?.({ audited: offset + batch.length, requested: sampleCount });
  }
  const { equivalent, mismatched, safeUnavailable, blockingUnavailable,
    failClosedEquivalent, freshUnavailable } = counts;
  const unavailable = safeUnavailable + blockingUnavailable;
  const comparableSamples = equivalent + failClosedEquivalent + mismatched;
  const safeUnavailableBps = candidates.length
    ? Math.ceil((safeUnavailable * 10_000) / candidates.length) : 0;
  const freshUnavailableBps = candidates.length
    ? Math.ceil((freshUnavailable * 10_000) / candidates.length) : 0;
  const approved = comparableSamples >= minimumSamples && mismatched === 0
    && blockingUnavailable === 0 && freshUnavailableBps <= maxFreshUnavailableBps;
  return Object.freeze({ approved, requestedSamples: sampleCount,
    minimumSamples, auditedSamples: candidates.length, comparableSamples,
    equivalent, mismatched, unavailable, safeUnavailable, blockingUnavailable,
    failClosedEquivalent, freshUnavailable, safeUnavailableBps,
    freshUnavailableBps, maxFreshUnavailableBps, coverage, details });
}

module.exports = { runRobinhoodFreshWalletSignedOriginAudit };
