function mismatchThreshold(value) {
  const parsed = Number(value ?? 3);
  if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > 5) {
    throw new RangeError('mismatchThreshold must be between 2 and 5');
  }
  return parsed;
}

function observation(value) {
  if (value?.available !== true) return null;
  const holderCount = String(value.holderCount ?? '').trim();
  if (!/^\d+$/.test(holderCount)) throw new TypeError('audited holder count is invalid');
  const observedAt = new Date(value.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new TypeError('holder audit timestamp is invalid');
  }
  return Object.freeze({ holderCount: BigInt(holderCount).toString(), observedAt: observedAt.toISOString() });
}

function createRobinhoodHolderLiveAudit(options = {}) {
  const repository = options.repository;
  const observe = options.observeHolderCount;
  const requiredMismatches = mismatchThreshold(options.requiredMismatches);
  if (typeof repository?.getNextLiveCandidate !== 'function'
      || typeof repository?.getLiveCandidate !== 'function'
      || typeof repository?.recordLiveAudit !== 'function') {
    throw new TypeError('holder live audit repository is required');
  }
  if (typeof observe !== 'function') throw new TypeError('holder count observer is required');
  let active = null;

  async function runOnce() {
    const candidate = active
      ? await repository.getLiveCandidate(active.tokenAddress)
      : await repository.getNextLiveCandidate();
    if (!candidate) {
      active = null;
      return Object.freeze({ status: 'idle' });
    }
    const observed = observation(await observe(candidate.tokenAddress));
    if (!observed) {
      active = null;
      return Object.freeze({ status: 'unavailable', tokenAddress: candidate.tokenAddress });
    }
    if (active && Date.parse(observed.observedAt) <= Date.parse(active.lastObservedAt)) {
      return Object.freeze({
        status: 'waiting', tokenAddress: candidate.tokenAddress, mismatches: active.mismatches,
      });
    }

    const matched = observed.holderCount === candidate.holderCount;
    const stable = !matched && active?.tokenAddress === candidate.tokenAddress
      && active.localHolderCount === candidate.holderCount
      && active.observedHolderCount === observed.holderCount;
    const mismatches = matched ? 0 : (stable ? active.mismatches + 1 : 1);
    const suspected = mismatches >= requiredMismatches;
    const saved = await repository.recordLiveAudit({
      tokenAddress: candidate.tokenAddress,
      expectedHolderCount: candidate.holderCount,
      expectedVersion: candidate.version,
      observedAt: observed.observedAt,
    });
    if (matched || suspected) active = null;
    else active = {
      tokenAddress: candidate.tokenAddress,
      localHolderCount: candidate.holderCount,
      observedHolderCount: observed.holderCount,
      lastObservedAt: observed.observedAt,
      mismatches,
    };
    return Object.freeze({
      status: matched ? 'live-verified' : (suspected ? 'drift-suspected' : 'live-mismatch'),
      tokenAddress: candidate.tokenAddress,
      localHolderCount: candidate.holderCount,
      observedHolderCount: observed.holderCount,
      mismatches,
      version: saved.version,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  createRobinhoodHolderLiveAudit,
  __private: { mismatchThreshold, observation },
};
