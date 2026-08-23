const {
  createRobinhoodSniperShadowCandidateRepository,
} = require('../models/robinhood-sniper-shadow-candidate');
const {
  createRobinhoodHolderSniperMaterializer,
} = require('./robinhood-holder-sniper-materializer');

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function bucket(settled) {
  if (settled.status === 'rejected') return 'failed';
  return settled.value?.status === 'deferred' ? 'deferred' : 'completed';
}

function outcomeBucket(outcome) {
  if (outcome?.status === 'deferred') return 'deferred';
  if (outcome?.status === 'failed') return 'failed';
  return 'completed';
}

function createRobinhoodSniperShadowRunner(deps = {}) {
  const candidates = deps.candidates
    || (deps.candidateFactory || createRobinhoodSniperShadowCandidateRepository)();
  const materializer = deps.materializer
    || (deps.materializerFactory || createRobinhoodHolderSniperMaterializer)();
  if (typeof candidates?.listCandidates !== 'function'
      || (typeof materializer?.materializeTokens !== 'function'
        && typeof materializer?.materializeToken !== 'function')) {
    throw new TypeError('SNIPER shadow runner dependencies are invalid');
  }

  async function runBatch(input = {}) {
    const limit = boundedInteger(input.limit, 10, 1, 100, 'batch limit');
    const concurrency = boundedInteger(input.concurrency, 1, 1, 4, 'concurrency');
    const retryMs = boundedInteger(
      input.retryMs, 3_600_000, 60_000, 86_400_000, 'retryMs'
    );
    const tokenAddresses = await candidates.listCandidates({
      limit, retryMs, afterToken: input.afterToken || null,
    });
    const counts = { completed: 0, deferred: 0, failed: 0 };
    if (typeof materializer.materializeTokens === 'function') {
      const outcomes = await materializer.materializeTokens(tokenAddresses, { concurrency });
      for (const outcome of outcomes) counts[outcomeBucket(outcome)] += 1;
      return Object.freeze({
        mode: 'shadow', candidates: tokenAddresses.length, ...counts,
        nextToken: tokenAddresses.at(-1) || null,
        exhausted: tokenAddresses.length < limit,
      });
    }
    for (let offset = 0; offset < tokenAddresses.length; offset += concurrency) {
      const batch = tokenAddresses.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(
        batch.map((tokenAddress) => materializer.materializeToken(tokenAddress))
      );
      for (const result of settled) counts[bucket(result)] += 1;
    }
    return Object.freeze({
      mode: 'shadow', candidates: tokenAddresses.length, ...counts,
      nextToken: tokenAddresses.at(-1) || null,
      exhausted: tokenAddresses.length < limit,
    });
  }

  return Object.freeze({ runBatch });
}

module.exports = {
  createRobinhoodSniperShadowRunner,
  __private: { bucket, outcomeBucket },
};
