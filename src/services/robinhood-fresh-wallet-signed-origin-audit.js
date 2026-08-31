const { inferPriorSignedActivity } = require('./robinhood-wallet-signed-origin-domain');
const { compareRobinhoodFreshWalletEvidence } = require('./robinhood-fresh-wallet-rule');

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

async function runRobinhoodFreshWalletSignedOriginAudit(deps = {}, options = {}) {
  const { repository, archiveSource } = deps;
  if (!repository?.loadCoverage || !repository?.sampleCandidates
      || !repository?.loadOrigins || !archiveSource?.readEvidenceBatch) {
    throw new TypeError('FRESH signed-origin audit dependencies are incomplete');
  }
  const sampleCount = bounded(options.sampleCount, 500, 1, 5000, 'sampleCount');
  const minimumSamples = bounded(options.minimumSamples, 100, 1, sampleCount,
    'minimumSamples');
  const batchSize = bounded(options.batchSize, 100, 1, 100, 'batchSize');
  const coverage = await repository.loadCoverage();
  const candidates = await repository.sampleCandidates(sampleCount);
  let equivalent = 0; let mismatched = 0; let unavailable = 0;
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
      const archive = archives[index]; const origin = origins.get(candidate.walletAddress);
      const inference = inferPriorSignedActivity({ cutoffBlock: archive.cutoff.number,
        coverage, firstBuy: { blockNumber: candidate.blockNumber,
          transactionIndex: candidate.transactionIndex },
        signedOrigin: origin && { blockNumber: origin.blockNumber,
          transactionIndex: origin.transactionIndex, nonce: origin.nonce },
      });
      if (inference.status !== 'ready') {
        unavailable += 1;
        if (details.length < MAX_DETAILS) details.push({ tokenAddress: candidate.tokenAddress,
          walletAddress: candidate.walletAddress, status: 'unavailable', reason: inference.reason });
        return;
      }
      const comparison = compareRobinhoodFreshWalletEvidence(archive,
        liveEvidence(archive, inference));
      if (comparison.equivalent) equivalent += 1;
      else {
        mismatched += 1;
        if (details.length < MAX_DETAILS) details.push({ tokenAddress: candidate.tokenAddress,
          walletAddress: candidate.walletAddress, status: 'mismatched', ...comparison });
      }
    });
    options.onProgress?.({ audited: offset + batch.length, requested: sampleCount });
  }
  const approved = candidates.length >= minimumSamples && mismatched === 0 && unavailable === 0;
  return Object.freeze({ approved, requestedSamples: sampleCount,
    minimumSamples, auditedSamples: candidates.length, equivalent, mismatched, unavailable,
    coverage, details });
}

module.exports = { runRobinhoodFreshWalletSignedOriginAudit };
