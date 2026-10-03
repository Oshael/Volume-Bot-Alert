const MAX_RETRY_TOKENS = 10_000;

function frontierKey(candidate) {
  return `${candidate.throughBlockNumber || ''}:${candidate.throughBlockHash || ''}`;
}

function createHolderIntelligenceRetry(options = {}) {
  const now = options.now || Date.now;
  const maxEntries = options.maxEntries ?? MAX_RETRY_TOKENS;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_RETRY_TOKENS) {
    throw new Error('holder intelligence retry capacity is invalid');
  }
  const entries = new Map();

  function isDue(candidate) {
    const entry = entries.get(candidate.tokenAddress);
    if (entry && entry.frontier !== frontierKey(candidate)) {
      entries.delete(candidate.tokenAddress);
      return true;
    }
    return !entry || entry.retryAt <= now();
  }

  function record(candidate, results, config) {
    const rejected = results.find((result) => result.status === 'rejected');
    const deferred = results.some((result) => result.value?.status === 'deferred');
    const unchanged = results.every((result) => (
      ['unchanged', 'stale_ignored'].includes(result.value?.status)
    ));
    const previous = entries.get(candidate.tokenAddress);
    const attempts = rejected ? (previous?.attempts || 0) + 1 : 0;
    let delay = 0;
    if (rejected) delay = Math.min(config.maxErrorBackoffMs,
      config.intervalMs * (2 ** Math.min(attempts, 8)));
    else if (deferred) delay = config.intervalMs;
    else if (unchanged) delay = config.unavailableRetryMs;
    entries.delete(candidate.tokenAddress);
    if (delay) {
      entries.set(candidate.tokenAddress, {
        frontier: frontierKey(candidate), attempts, retryAt: now() + delay,
      });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }
    return rejected ? {
      code: rejected.reason?.code || 'holder_intelligence_error',
      message: String(rejected.reason?.message || rejected.reason).slice(0, 500),
    } : null;
  }

  return Object.freeze({ isDue, record, getSize: () => entries.size });
}

module.exports = { createHolderIntelligenceRetry };
