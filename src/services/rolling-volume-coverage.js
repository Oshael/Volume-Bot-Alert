const WINDOW_MS = Object.freeze({
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
});
const WINDOWS = Object.freeze(Object.keys(WINDOW_MS));
const FIELD_BY_WINDOW = Object.freeze({
  '1m': 'vol1m', '5m': 'vol5m', '1h': 'vol1h', '6h': 'vol6h', '24h': 'vol24h',
});

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestampMsOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function completeShorterWindows(window, normalized, coverage) {
  const targetMs = WINDOW_MS[window];
  return WINDOWS
    .filter((candidate) => WINDOW_MS[candidate] < targetMs && coverage[candidate] === 'complete')
    .map((candidate) => ({
      window: candidate,
      value: numberOrNull(normalized[FIELD_BY_WINDOW[candidate]]),
    }))
    .filter((candidate) => candidate.value != null);
}

function deriveRollingVolumeCoverage(rawSnapshot = {}, normalizedSnapshot = {}, options = {}) {
  const nowMs = timestampMsOrNull(options.now || new Date());
  if (nowMs == null) throw new Error('Rolling volume coverage now is invalid');
  const createdAtMs = timestampMsOrNull(
    options.tokenCreatedAt || rawSnapshot.tokenCreatedAt || rawSnapshot.pairCreatedAt,
  );
  const ageMs = createdAtMs != null && createdAtMs <= nowMs ? nowMs - createdAtMs : null;
  const coverage = {};

  for (const window of WINDOWS) {
    const field = FIELD_BY_WINDOW[window];
    const value = numberOrNull(normalizedSnapshot[field]);
    const direct = numberOrNull(rawSnapshot[field]);
    if (value == null) {
      coverage[window] = 'unavailable';
      continue;
    }
    if (direct != null && direct === value) {
      coverage[window] = 'complete';
      continue;
    }
    const shorter = completeShorterWindows(window, normalizedSnapshot, coverage);
    const lifetimeCovered = ageMs != null && shorter.some((candidate) => (
      ageMs <= WINDOW_MS[candidate.window] && candidate.value === value
    ));
    if (lifetimeCovered) {
      coverage[window] = 'complete';
      continue;
    }
    coverage[window] = 'partial';
  }

  return Object.freeze(coverage);
}

module.exports = {
  FIELD_BY_WINDOW,
  WINDOWS,
  WINDOW_MS,
  deriveRollingVolumeCoverage,
};
