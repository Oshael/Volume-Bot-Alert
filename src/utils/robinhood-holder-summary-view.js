const HOLDER_FRESHNESS_TARGET_MS = 15 * 60 * 1000;

function optionalIso(value, label) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function optionalHolderCount(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) throw new Error('holder count is invalid');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error('holder count exceeds safe integer range');
  return parsed;
}

function normalizeRobinhoodHolderSummary(row, asOf = new Date()) {
  const holderCount = optionalHolderCount(row?.holder_count);
  const holderObservedAt = optionalIso(row?.holder_observed_at, 'holder observedAt');
  const holderCheckedAt = optionalIso(row?.holder_checked_at, 'holder checkedAt');
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('holder summary asOf is invalid');

  let holderFreshness = 'unavailable';
  if (holderCount != null && holderObservedAt != null) {
    holderFreshness = asOfMs - Date.parse(holderObservedAt) <= HOLDER_FRESHNESS_TARGET_MS
      ? 'fresh'
      : 'stale';
  }

  return Object.freeze({
    holderCount,
    holderObservedAt,
    holderCheckedAt,
    holderFreshness,
  });
}

function buildDailyHolderHistory(snapshots, requestedDays) {
  if (!Array.isArray(snapshots)) throw new TypeError('holder snapshots must be an array');
  const days = Number(requestedDays);
  if (!Number.isSafeInteger(days) || days < 1 || snapshots.length > days + 1) {
    throw new Error('holder snapshot range is invalid');
  }
  let previousDateMs = null;
  const normalized = snapshots.map((snapshot) => {
    const date = String(snapshot?.date || '');
    const dateMs = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
    const holderCount = optionalHolderCount(snapshot?.holderCount);
    const observedAt = optionalIso(snapshot?.observedAt, 'daily holder observedAt');
    if (!Number.isFinite(dateMs) || holderCount == null || observedAt == null
      || (previousDateMs != null && dateMs <= previousDateMs)) {
      throw new Error('holder snapshots are invalid');
    }
    previousDateMs = dateMs;
    return Object.freeze({ date, dateMs, holderCount, observedAt });
  });
  if (!normalized.length) return Object.freeze({ baseline: null, points: Object.freeze([]) });

  const baseline = Object.freeze({
    date: normalized[0].date,
    holderCount: normalized[0].holderCount,
    observedAt: normalized[0].observedAt,
  });
  const points = normalized.slice(1).map((current, index) => {
    const previous = normalized[index];
    const complete = current.dateMs - previous.dateMs === 24 * 60 * 60 * 1000;
    const delta24h = complete ? current.holderCount - previous.holderCount : null;
    return Object.freeze({
      date: current.date,
      holderCount: current.holderCount,
      observedAt: current.observedAt,
      delta24h,
      delta24hPct: complete && previous.holderCount > 0
        ? (delta24h / previous.holderCount) * 100
        : null,
      comparison: complete ? 'complete' : 'unavailable',
    });
  });
  return Object.freeze({ baseline, points: Object.freeze(points) });
}

module.exports = {
  HOLDER_FRESHNESS_TARGET_MS,
  buildDailyHolderHistory,
  normalizeRobinhoodHolderSummary,
};
