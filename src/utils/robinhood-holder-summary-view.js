const HOLDER_FRESHNESS_TARGET_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HOLDER_SERIES_HOURS = 168;
const HOLDER_BAR_HOURS = 4;
const HOLDER_DELTA_WINDOWS = Object.freeze([
  ['4h', 4], ['12h', 12], ['1d', 24], ['3d', 72], ['7d', 168],
]);

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
  const holderSource = row?.holder_source == null ? 'blockscout' : row.holder_source;
  if (!['blockscout', 'ledger_live'].includes(holderSource)) {
    throw new Error('holder source is invalid');
  }
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('holder summary asOf is invalid');

  let holderFreshness = 'unavailable';
  const freshnessAt = holderSource === 'ledger_live' ? holderCheckedAt : holderObservedAt;
  if (holderCount != null && freshnessAt != null) {
    holderFreshness = asOfMs - Date.parse(freshnessAt) <= HOLDER_FRESHNESS_TARGET_MS
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

function normalizeSeriesPoint(value, previousMs) {
  const bucketStart = optionalIso(value?.bucketStart, 'holder bucketStart');
  const bucketMs = Date.parse(bucketStart);
  const observedAt = optionalIso(value?.observedAt, 'holder bucket observedAt');
  const holderCount = optionalHolderCount(value?.holderCount);
  const source = value?.source;
  if (bucketMs % HOUR_MS !== 0 || bucketMs <= previousMs || holderCount == null
    || observedAt == null
    || !['blockscout', 'ledger_live'].includes(source)) {
    throw new Error('hourly holder buckets are invalid');
  }
  return { bucketStart, bucketMs, holderCount, source, observedAt };
}

function hasSequence(points, fromMs, throughMs) {
  for (let bucketMs = fromMs; bucketMs <= throughMs; bucketMs += HOUR_MS) {
    if (!points.has(bucketMs)) return false;
  }
  return true;
}

function comparison(points, fromMs, throughMs) {
  const complete = hasSequence(points, fromMs, throughMs);
  const first = points.get(fromMs);
  const last = points.get(throughMs);
  return Object.freeze({
    delta: complete ? last.holderCount - first.holderCount : null,
    comparison: complete ? 'complete' : 'unavailable',
    from: new Date(fromMs).toISOString(),
    through: last?.observedAt || null,
  });
}

function indexHourlyBuckets(buckets, bounds) {
  if (!Array.isArray(buckets) || buckets.length > HOLDER_SERIES_HOURS + 1) {
    throw new Error('hourly holder bucket range is invalid');
  }
  const points = new Map();
  let previousMs = -Infinity;
  for (const bucket of buckets) {
    const point = normalizeSeriesPoint(bucket, previousMs);
    const observedMs = Date.parse(point.observedAt);
    if (point.bucketMs < bounds.firstBucketMs || point.bucketMs > bounds.currentBucketMs
      || observedMs < point.bucketMs || observedMs >= point.bucketMs + HOUR_MS
      || observedMs > bounds.asOfMs) {
      throw new Error('hourly holder bucket range is invalid');
    }
    points.set(point.bucketMs, point);
    previousMs = point.bucketMs;
  }
  return points;
}

function applyCurrentHolder(points, current, bounds) {
  if (current?.holderCount == null || current?.observedAt == null) return null;
  const holderCount = optionalHolderCount(current.holderCount);
  const observedAt = optionalIso(current.observedAt, 'current holder observedAt');
  const observedMs = Date.parse(observedAt);
  const source = current.source;
  if (holderCount == null || observedMs > bounds.asOfMs
    || !['blockscout', 'ledger_live'].includes(source)) {
    throw new Error('current holder summary is invalid');
  }
  const normalized = Object.freeze({ holderCount, source, observedAt });
  const bucketMs = Math.floor(observedMs / HOUR_MS) * HOUR_MS;
  const stored = points.get(bucketMs);
  const replace = !stored
    || (stored.source === 'blockscout' && source === 'ledger_live')
    || (stored.source === source && observedMs >= Date.parse(stored.observedAt));
  if (replace && bucketMs === bounds.currentBucketMs) {
    points.set(bucketMs, {
      bucketStart: new Date(bucketMs).toISOString(), bucketMs,
      holderCount, source, observedAt,
    });
  }
  return normalized;
}

function buildHolderBars(points, currentBucketMs) {
  const currentBarStart = Math.floor(currentBucketMs / (HOLDER_BAR_HOURS * HOUR_MS))
    * HOLDER_BAR_HOURS * HOUR_MS;
  const bars = [];
  for (let index = 41; index >= 0; index -= 1) {
    const startMs = currentBarStart - (index * HOLDER_BAR_HOURS * HOUR_MS);
    const open = startMs === currentBarStart;
    const throughMs = open ? currentBucketMs : startMs + (3 * HOUR_MS);
    const result = comparison(points, startMs - HOUR_MS, throughMs);
    const last = points.get(throughMs);
    bars.push(Object.freeze({
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + (HOLDER_BAR_HOURS * HOUR_MS)).toISOString(),
      holderCount: last?.holderCount ?? null,
      observedAt: last?.observedAt ?? null,
      delta: result.delta,
      status: open ? 'open' : 'complete',
      comparison: result.comparison,
    }));
  }
  return Object.freeze(bars);
}

function buildHourlyHolderSeries(buckets, current, asOf = new Date()) {
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('hourly holder series asOf is invalid');
  const currentBucketMs = Math.floor(asOfMs / HOUR_MS) * HOUR_MS;
  const bounds = {
    asOfMs, currentBucketMs,
    firstBucketMs: currentBucketMs - (HOLDER_SERIES_HOURS * HOUR_MS),
  };
  const points = indexHourlyBuckets(buckets, bounds);
  const normalizedCurrent = applyCurrentHolder(points, current, bounds);
  const deltas = Object.fromEntries(HOLDER_DELTA_WINDOWS.map(([key, hours]) => [
    key, comparison(points, currentBucketMs - (hours * HOUR_MS), currentBucketMs),
  ]));
  return Object.freeze({
    resolution: '1h', interval: '4h', hours: HOLDER_SERIES_HOURS,
    current: normalizedCurrent,
    deltas: Object.freeze(deltas),
    bars: buildHolderBars(points, currentBucketMs),
  });
}

module.exports = {
  HOLDER_FRESHNESS_TARGET_MS,
  HOLDER_SERIES_HOURS,
  buildDailyHolderHistory,
  buildHourlyHolderSeries,
  normalizeRobinhoodHolderSummary,
};
