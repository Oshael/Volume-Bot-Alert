const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function toFiniteNumberOrNull(value) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestampMsOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function hasPositiveVolume(value) {
  const parsed = toFiniteNumberOrNull(value);
  return parsed != null && parsed > 0;
}

function maxPositiveVolume(values) {
  let max = null;

  for (const value of values) {
    const parsed = toFiniteNumberOrNull(value);
    if (parsed != null && parsed > 0) {
      max = max == null ? parsed : Math.max(max, parsed);
    }
  }

  return max;
}

function fillYoungTokenVolumeWindows(snapshot = {}, options = {}) {
  const createdAtMs = toTimestampMsOrNull(snapshot.tokenCreatedAt || snapshot.pairCreatedAt);
  const nowMs = toTimestampMsOrNull(options.now || new Date());
  if (!(createdAtMs > 0) || !(nowMs > createdAtMs)) {
    return { ...snapshot };
  }

  const ageMs = nowMs - createdAtMs;
  const filled = { ...snapshot };

  if (ageMs < ONE_HOUR_MS && !hasPositiveVolume(filled.vol1h)) {
    const fallbackVol1h = maxPositiveVolume([
      filled.vol1m,
      filled.vol5m,
    ]);
    if (fallbackVol1h != null) {
      filled.vol1h = fallbackVol1h;
    }
  }

  if (ageMs < SIX_HOURS_MS && !hasPositiveVolume(filled.vol6h)) {
    const fallbackVol6h = maxPositiveVolume([
      filled.vol1m,
      filled.vol5m,
      filled.vol1h,
    ]);
    if (fallbackVol6h != null) {
      filled.vol6h = fallbackVol6h;
    }
  }

  if (ageMs < TWENTY_FOUR_HOURS_MS && !hasPositiveVolume(filled.vol24h)) {
    const fallbackVol24h = maxPositiveVolume([
      filled.vol1m,
      filled.vol5m,
      filled.vol1h,
      filled.vol6h,
    ]);
    if (fallbackVol24h != null) {
      filled.vol24h = fallbackVol24h;
    }
  }

  return filled;
}

module.exports = {
  fillYoungTokenVolumeWindows,
  __private: {
    maxPositiveVolume,
    toFiniteNumberOrNull,
    toTimestampMsOrNull,
  },
};
