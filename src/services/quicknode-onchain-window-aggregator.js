const DEFAULT_WINDOWS = Object.freeze([
  Object.freeze({ label: '1m', durationMs: 60 * 1000 }),
  Object.freeze({ label: '5m', durationMs: 5 * 60 * 1000 }),
]);
const DEFAULT_REPORT_LIMIT = 10;

function normalizeText(value) {
  return String(value || '').trim();
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundSol(value) {
  return Math.round((Number(value) || 0) * 1e9) / 1e9;
}

function roundUsd(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeWindows(windows = DEFAULT_WINDOWS) {
  return (Array.isArray(windows) ? windows : DEFAULT_WINDOWS)
    .map((window) => ({
      label: normalizeText(window?.label),
      durationMs: toFiniteNumber(window?.durationMs, 0),
    }))
    .filter((window) => window.label && window.durationMs > 0)
    .sort((a, b) => a.durationMs - b.durationMs);
}

function resolveObservedAtMs(candidate = {}, nowMs = Date.now()) {
  const explicit = toFiniteNumber(candidate.observedAtMs);
  if (explicit != null && explicit > 0) {
    return explicit;
  }

  const blockTime = toFiniteNumber(candidate.blockTime);
  if (blockTime != null && blockTime > 0) {
    return blockTime * 1000;
  }

  return nowMs;
}

function normalizeCandidate(candidate = {}, nowMs = Date.now()) {
  const tokenMint = normalizeText(candidate.tokenMint);
  const signature = normalizeText(candidate.signature);
  const program = normalizeText(candidate.program);
  if (!tokenMint || !signature || !program) {
    return null;
  }

  return {
    tokenMint,
    signature,
    program,
    observedAtMs: resolveObservedAtMs(candidate, nowMs),
    estimatedSolVolume: toFiniteNumber(candidate.estimatedSolVolume, 0) || 0,
    estimatedUsdVolume: toFiniteNumber(candidate.estimatedUsdVolume, 0) || 0,
    volumeSource: normalizeText(candidate.volumeSource) || 'none',
  };
}

function createEmptyWindowReport(tokenMint, window) {
  return {
    tokenMint,
    window: window.label,
    windowMs: window.durationMs,
    swaps: 0,
    estimatedSolVolume: 0,
    estimatedUsdVolume: 0,
    programs: new Set(),
    volumeSources: new Map(),
    latestSignature: null,
    latestObservedAtMs: null,
    sampleSignatures: [],
  };
}

function addEventToWindowReport(report, event) {
  report.swaps += 1;
  report.estimatedSolVolume += event.estimatedSolVolume;
  report.estimatedUsdVolume += event.estimatedUsdVolume;
  report.programs.add(event.program);
  report.volumeSources.set(event.volumeSource, (report.volumeSources.get(event.volumeSource) || 0) + 1);

  if (!report.latestObservedAtMs || event.observedAtMs >= report.latestObservedAtMs) {
    report.latestObservedAtMs = event.observedAtMs;
    report.latestSignature = event.signature;
  }
  if (!report.sampleSignatures.includes(event.signature) && report.sampleSignatures.length < 3) {
    report.sampleSignatures.push(event.signature);
  }
}

function finalizeWindowReport(report) {
  return {
    ...report,
    estimatedSolVolume: roundSol(report.estimatedSolVolume),
    estimatedUsdVolume: roundUsd(report.estimatedUsdVolume),
    programs: [...report.programs].sort(),
    volumeSources: Object.fromEntries([...report.volumeSources.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function compareWindowReports(a, b) {
  if (a.windowMs !== b.windowMs) {
    return a.windowMs - b.windowMs;
  }
  if (b.swaps !== a.swaps) {
    return b.swaps - a.swaps;
  }
  if (b.estimatedUsdVolume !== a.estimatedUsdVolume) {
    return b.estimatedUsdVolume - a.estimatedUsdVolume;
  }
  return b.estimatedSolVolume - a.estimatedSolVolume;
}

function createOnchainWindowAggregator(options = {}) {
  const windows = normalizeWindows(options.windows);
  const maxWindowMs = Math.max(...windows.map((window) => window.durationMs), 0);
  const eventsBySignature = new Map();

  function prune(nowMs = Date.now()) {
    const cutoffMs = nowMs - maxWindowMs;
    let removed = 0;
    for (const [signature, event] of eventsBySignature.entries()) {
      if (event.observedAtMs < cutoffMs) {
        eventsBySignature.delete(signature);
        removed += 1;
      }
    }
    return removed;
  }

  function add(candidate, nowMs = Date.now()) {
    const event = normalizeCandidate(candidate, nowMs);
    if (!event) {
      return { accepted: false, reason: 'invalid_candidate' };
    }
    if (eventsBySignature.has(event.signature)) {
      return { accepted: false, reason: 'duplicate_signature' };
    }
    eventsBySignature.set(event.signature, event);
    prune(nowMs);
    return { accepted: true, event };
  }

  function addMany(candidates = [], nowMs = Date.now()) {
    return (Array.isArray(candidates) ? candidates : []).map((candidate) => add(candidate, nowMs));
  }

  function snapshot(nowMs = Date.now(), optionsForSnapshot = {}) {
    prune(nowMs);
    const limit = Math.max(1, Number(optionsForSnapshot.limit) || DEFAULT_REPORT_LIMIT);
    const reports = [];

    for (const window of windows) {
      const cutoffMs = nowMs - window.durationMs;
      const byToken = new Map();
      for (const event of eventsBySignature.values()) {
        if (event.observedAtMs < cutoffMs) {
          continue;
        }
        if (!byToken.has(event.tokenMint)) {
          byToken.set(event.tokenMint, createEmptyWindowReport(event.tokenMint, window));
        }
        addEventToWindowReport(byToken.get(event.tokenMint), event);
      }

      reports.push(...[...byToken.values()]
        .map(finalizeWindowReport)
        .sort(compareWindowReports)
        .slice(0, limit));
    }

    return reports;
  }

  return {
    add,
    addMany,
    prune,
    snapshot,
    size: () => eventsBySignature.size,
  };
}

function buildWindowReports(candidates = [], options = {}) {
  const nowMs = toFiniteNumber(options.nowMs, Date.now());
  const aggregator = createOnchainWindowAggregator({ windows: options.windows });
  aggregator.addMany(candidates, nowMs);
  return aggregator.snapshot(nowMs, { limit: options.limit });
}

module.exports = {
  DEFAULT_REPORT_LIMIT,
  DEFAULT_WINDOWS,
  buildWindowReports,
  createOnchainWindowAggregator,
  __private: {
    normalizeCandidate,
    normalizeWindows,
    resolveObservedAtMs,
  },
};
