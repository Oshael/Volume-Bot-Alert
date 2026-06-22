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

module.exports = {
  isVolume24hCoherentWithShorterWindows,
  __private: {
    toFiniteNumberOrNull,
  },
};
