function requiredMatches(value) {
  const parsed = Number(value ?? 3);
  if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > 5) {
    throw new RangeError('requiredMatches must be between 2 and 5');
  }
  return parsed;
}

function normalizeObservation(value) {
  if (value?.available !== true) return null;
  const holderCount = String(value.holderCount ?? '').trim();
  if (!/^\d+$/.test(holderCount)) throw new TypeError('observed holder count is invalid');
  const parsedAt = new Date(value.observedAt);
  if (!Number.isFinite(parsedAt.getTime())) throw new TypeError('holder observation timestamp is invalid');
  return Object.freeze({ holderCount: BigInt(holderCount).toString(), observedAt: parsedAt.toISOString() });
}

function createRobinhoodHolderReconciliation(options = {}) {
  const repository = options.repository;
  const observe = options.observeHolderCount;
  const matchesRequired = requiredMatches(options.requiredMatches);
  if (typeof repository?.getNextCandidate !== 'function'
      || typeof repository?.getCandidate !== 'function'
      || typeof repository?.recordComparison !== 'function') {
    throw new TypeError('holder reconciliation repository is required');
  }
  if (typeof observe !== 'function') throw new TypeError('holder count observer is required');

  let active = null;

  async function runOnce() {
    const candidate = active
      ? await repository.getCandidate(active.tokenAddress)
      : await repository.getNextCandidate();
    if (!candidate) {
      active = null;
      return Object.freeze({ status: 'idle' });
    }
    const observation = normalizeObservation(await observe(candidate.tokenAddress));
    if (!observation) {
      active = null;
      return Object.freeze({ status: 'unavailable', tokenAddress: candidate.tokenAddress });
    }
    if (active && Date.parse(observation.observedAt) <= Date.parse(active.lastObservedAt)) {
      return Object.freeze({
        status: 'waiting', tokenAddress: candidate.tokenAddress, matches: active.matches,
      });
    }

    const matched = observation.holderCount === candidate.holderCount;
    const matches = matched && active?.tokenAddress === candidate.tokenAddress
      ? active.matches + 1 : (matched ? 1 : 0);
    const promote = matched && matches >= matchesRequired;
    const saved = await repository.recordComparison({
      tokenAddress: candidate.tokenAddress,
      expectedHolderCount: candidate.holderCount,
      expectedVersion: candidate.version,
      observedAt: observation.observedAt,
      promote,
    });
    if (!matched || promote) active = null;
    else active = { tokenAddress: candidate.tokenAddress, matches, lastObservedAt: observation.observedAt };

    return Object.freeze({
      status: promote ? 'live' : (matched ? 'matching' : 'mismatch'),
      tokenAddress: candidate.tokenAddress,
      localHolderCount: candidate.holderCount,
      observedHolderCount: observation.holderCount,
      matches,
      version: saved.version,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  createRobinhoodHolderReconciliation,
  __private: { normalizeObservation, requiredMatches },
};
