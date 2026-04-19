import type { AlertEntry } from '../state/app-state';

const RECENT_DISMISSED_KEY = 'recent_dismissed';
const OLD_WEEK_DISMISSED_KEY = 'old_week_dismissed';
const RECENT_REMOVAL_LOG_KEY = 'recent_removal_log';
const OLD_WEEK_REMOVAL_LOG_KEY = 'old_week_removal_log';
const ALERTS_KEY = 'alerts';

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

export function loadAlerts(scope: string) {
  const entries = readJson<AlertEntry[]>(scope, ALERTS_KEY, []);
  const pruned = pruneAlerts(entries);
  writeJson(scope, ALERTS_KEY, pruned);
  return pruned;
}

export function saveAlerts(scope: string, entries: AlertEntry[]) {
  writeJson(scope, ALERTS_KEY, pruneAlerts(entries));
}
