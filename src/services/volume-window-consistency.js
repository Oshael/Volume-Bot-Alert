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

function isCumulativeVolumeWindowCoherent(snapshot = {}) {
  if (!isVolume24hCoherentWithShorterWindows(snapshot)) {
    return false;
  }

  const vol1h = toFiniteNumberOrNull(snapshot.vol1h);
  const vol6h = toFiniteNumberOrNull(snapshot.vol6h);
  return vol1h == null || vol6h == null || vol1h <= vol6h;
}

function chooseNormalizedWindowValue(current, previous, minimum) {
  if (minimum == null || !Number.isFinite(minimum)) {
    return current;
  }
  if (previous != null && previous >= minimum) {
    return previous;
  }
  return Math.max(current ?? 0, minimum);
}

function normalizeCumulativeVolumeWindows(snapshot = {}, previous = {}) {
  if (isCumulativeVolumeWindowCoherent(snapshot)) {
    return snapshot;
  }

  const vol1h = toFiniteNumberOrNull(snapshot.vol1h);
  const vol6h = toFiniteNumberOrNull(snapshot.vol6h);
  const vol24h = toFiniteNumberOrNull(snapshot.vol24h);
  const previousVol6h = toFiniteNumberOrNull(previous.vol6h);
  const previousVol24h = toFiniteNumberOrNull(previous.vol24h);
  const normalizedVol6h = chooseNormalizedWindowValue(vol6h, previousVol6h, vol1h);
  const minimumVol24h = Math.max(
    vol1h ?? Number.NEGATIVE_INFINITY,
    normalizedVol6h ?? Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(minimumVol24h)) {
    return snapshot;
  }

  return {
    ...snapshot,
    vol6h: normalizedVol6h,
    vol24h: chooseNormalizedWindowValue(vol24h, previousVol24h, minimumVol24h),
  };
}

function normalizeVolume24hWithShorterWindows(snapshot = {}, previous = {}) {
  return normalizeCumulativeVolumeWindows(snapshot, previous);
}

module.exports = {
  isVolume24hCoherentWithShorterWindows,
  isCumulativeVolumeWindowCoherent,
  normalizeCumulativeVolumeWindows,
  normalizeVolume24hWithShorterWindows,
  __private: {
    toFiniteNumberOrNull,
    chooseNormalizedWindowValue,
  },
};
