const {
  createRobinhoodInsiderShadowCandidateRepository,
} = require('../models/robinhood-insider-shadow-candidate');
const {
  createRobinhoodHolderInsiderMaterializer,
} = require('./robinhood-holder-insider-materializer');

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

function createRobinhoodInsiderShadowRunner(deps = {}) {
  const candidates = deps.candidates
    || (deps.candidateFactory || createRobinhoodInsiderShadowCandidateRepository)();
  const materializer = deps.materializer
    || (deps.materializerFactory || createRobinhoodHolderInsiderMaterializer)();
  if (typeof candidates?.listCandidates !== 'function'
      || typeof materializer?.materializeToken !== 'function') {
    throw new TypeError('INSIDER shadow runner dependencies are invalid');
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
    for (let offset = 0; offset < tokenAddresses.length; offset += concurrency) {
      const settled = await Promise.allSettled(tokenAddresses.slice(offset, offset + concurrency)
        .map((tokenAddress) => materializer.materializeToken(tokenAddress)));
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

module.exports = { createRobinhoodInsiderShadowRunner };
