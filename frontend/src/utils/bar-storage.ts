import type { AlertEntry, TokenSparklineEntry } from '../state/app-state';

const RECENT_DISMISSED_KEY = 'recent_dismissed';
const OLD_WEEK_DISMISSED_KEY = 'old_week_dismissed';
const RECENT_REMOVAL_LOG_KEY = 'recent_removal_log';
const OLD_WEEK_REMOVAL_LOG_KEY = 'old_week_removal_log';
const ALERTS_KEY = 'alerts';
const ALERT_SPARKLINES_KEY = 'alert_sparklines';

function scopedKey(scope: string, key: string) {
  return `frontend_vite:${scope}:${key}`;
}

function getStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

function readJson<T>(scope: string, key: string, fallback: T): T {
  const storage = getStorage();
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(scopedKey(scope, key));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(scope: string, key: string, value: unknown) {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(scopedKey(scope, key), JSON.stringify(value));
  } catch {
    // Ignore storage quota or serialization errors in the migration shell.
  }
}

function removeScopedItem(scope: string, key: string) {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.removeItem(scopedKey(scope, key));
  } catch {
    // Ignore storage errors in the migration shell.
  }
}

export function loadDismissedRecent(scope: string) {
  return readJson<string[]>(scope, RECENT_DISMISSED_KEY, []);
}

export function saveDismissedRecent(scope: string, addresses: string[]) {
  writeJson(scope, RECENT_DISMISSED_KEY, [...new Set(addresses)].sort((a, b) => a.localeCompare(b)));
}

export function loadDismissedOldWeek(scope: string) {
  return readJson<string[]>(scope, OLD_WEEK_DISMISSED_KEY, []);
}

export function saveDismissedOldWeek(scope: string, addresses: string[]) {
  writeJson(scope, OLD_WEEK_DISMISSED_KEY, [...new Set(addresses)].sort((a, b) => a.localeCompare(b)));
}

export function clearRecentRemovalLogStorage(scope: string) {
  removeScopedItem(scope, RECENT_REMOVAL_LOG_KEY);
}

export function clearOldWeekRemovalLogStorage(scope: string) {
  removeScopedItem(scope, OLD_WEEK_REMOVAL_LOG_KEY);
}

function pruneAlerts(entries: AlertEntry[]) {
  return entries
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim())
    .slice(0, 100);
}

function normalizeSparklineCacheEntry(address: string, value: unknown): TokenSparklineEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const entry = value as Partial<TokenSparklineEntry>;
  const series = Array.isArray(entry.series)
    ? entry.series
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
      .slice(0, 500)
    : [];
  if (series.length < 2) {
    return null;
  }

  return {
    address,
    pairAddress: typeof entry.pairAddress === 'string' ? entry.pairAddress : null,
    bucketCount: Number(entry.bucketCount) || 0,
    coverageRatio: entry.coverageRatio == null ? null : Number(entry.coverageRatio),
    effectiveHours: entry.effectiveHours == null ? null : Number(entry.effectiveHours),
    granularityMinutes: entry.granularityMinutes == null ? null : Number(entry.granularityMinutes),
    latestBucketAt: typeof entry.latestBucketAt === 'string' ? entry.latestBucketAt : null,
    generatedAt: typeof entry.generatedAt === 'string' ? entry.generatedAt : null,
    hours: Number(entry.hours) || undefined,
    points: Number(entry.points) || undefined,
    series,
  };
}

function pruneAlertSparklineCache(entries: Record<string, TokenSparklineEntry>) {
  const normalized: Record<string, TokenSparklineEntry> = {};

  for (const [address, value] of Object.entries(entries || {})) {
    const normalizedAddress = String(address || '').trim();
    if (!normalizedAddress) {
      continue;
    }

    const entry = normalizeSparklineCacheEntry(normalizedAddress, value);
    if (!entry) {
      continue;
    }

    normalized[normalizedAddress] = entry;
  }

  return normalized;
}

export function loadAlerts(scope: string) {
  const entries = readJson<AlertEntry[]>(scope, ALERTS_KEY, []);
  const pruned = pruneAlerts(entries);
  writeJson(scope, ALERTS_KEY, pruned);
  return pruned;
}

export function saveAlerts(scope: string, entries: AlertEntry[]) {
  writeJson(scope, ALERTS_KEY, pruneAlerts(entries));
}

export function loadAlertSparklineCache(scope: string) {
  const entries = readJson<Record<string, TokenSparklineEntry>>(scope, ALERT_SPARKLINES_KEY, {});
  const pruned = pruneAlertSparklineCache(entries);
  writeJson(scope, ALERT_SPARKLINES_KEY, pruned);
  return pruned;
}

export function saveAlertSparklineCache(scope: string, entries: Record<string, TokenSparklineEntry>) {
  writeJson(scope, ALERT_SPARKLINES_KEY, pruneAlertSparklineCache(entries));
}
