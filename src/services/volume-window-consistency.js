function toFiniteNumberOrNull(value) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isVolume24hCoherentWithShorterWindows(snapshot = {}) {
  const vol24h = toFiniteNumberOrNull(snapshot.vol24h);
  if (vol24h == null) {
    return true;
  }

  const shorterWindows = [
    toFiniteNumberOrNull(snapshot.vol1h),
    toFiniteNumberOrNull(snapshot.vol6h),
  ];

  return shorterWindows.every((volume) => volume == null || volume <= vol24h);
}

function normalizeVolume24hWithShorterWindows(snapshot = {}, previous = {}) {
  if (isVolume24hCoherentWithShorterWindows(snapshot)) {
    return snapshot;
  }

  const vol1h = toFiniteNumberOrNull(snapshot.vol1h);
  const vol6h = toFiniteNumberOrNull(snapshot.vol6h);
  const vol24h = toFiniteNumberOrNull(snapshot.vol24h);
  const previousVol24h = toFiniteNumberOrNull(previous.vol24h);
  const maxShorterWindow = Math.max(
    vol1h ?? Number.NEGATIVE_INFINITY,
    vol6h ?? Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(maxShorterWindow)) {
    return snapshot;
  }

  return {
    ...snapshot,
    vol24h: previousVol24h != null && previousVol24h >= maxShorterWindow
      ? previousVol24h
      : Math.max(vol24h ?? 0, maxShorterWindow),
  };
}

module.exports = {
  isVolume24hCoherentWithShorterWindows,
  normalizeVolume24hWithShorterWindows,
  __private: {
    toFiniteNumberOrNull,
  },
};
