import type { AlertEntry, TokenSparklineEntry } from '../state/app-state';
import {
  normalizeCompactSparklineCache,
  type CompactSparklineCacheEntry,
} from '../state/workspace-sparkline-refresh.ts';

const RECENT_DISMISSED_KEY = 'recent_dismissed';
const OLD_WEEK_DISMISSED_KEY = 'old_week_dismissed';
const RECENT_REMOVAL_LOG_KEY = 'recent_removal_log';
const OLD_WEEK_REMOVAL_LOG_KEY = 'old_week_removal_log';
const ALERTS_KEY = 'alerts';
const COMPACT_SPARKLINES_KEY = 'compact_sparklines';

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

function getAlertCreatedAt(entry: AlertEntry) {
  const createdAt = Number(entry.createdAt || 0);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function pruneAlerts(entries: AlertEntry[]) {
  return entries
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim())
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => getAlertCreatedAt(right.entry) - getAlertCreatedAt(left.entry) || left.index - right.index)
    .slice(0, 120)
    .map(({ entry }) => entry);
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

export function loadCompactSparklineCache(scope: string) {
  const canonical = readJson<unknown>(scope, COMPACT_SPARKLINES_KEY, {});
  const normalized = normalizeCompactSparklineCache(canonical);
  writeJson(scope, COMPACT_SPARKLINES_KEY, normalized);
  return normalized;
}

export function saveCompactSparklineCache(
  scope: string,
  entries: Record<string, CompactSparklineCacheEntry | TokenSparklineEntry>,
) {
  writeJson(scope, COMPACT_SPARKLINES_KEY, normalizeCompactSparklineCache(entries));
}
