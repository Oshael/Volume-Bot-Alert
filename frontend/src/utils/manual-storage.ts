import type { AddressItem } from '../services/api/config';

const MANUAL_TOKENS_KEY = 'manual_tokens';
const MANUAL_TOKENS_INIT_KEY = 'manual_tokens_initialized';

function scopedKey(scope: string, key: string) {
  return `frontend_vite:${scope}:${key}`;
}

function getStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

function normalizeItems(items: AddressItem[]) {
  return [...new Map(
    (Array.isArray(items) ? items : [])
      .map((item) => ({
        address: String(item?.address || '').trim(),
        label: item?.label == null ? null : String(item.label).trim() || null,
      }))
      .filter((item) => item.address)
      .map((item) => [item.address, item]),
  ).values()].sort((a, b) => a.address.localeCompare(b.address));
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
    // Ignore storage errors.
  }
}

function markInitialized(scope: string) {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(scopedKey(scope, MANUAL_TOKENS_INIT_KEY), '1');
  } catch {
    // Ignore storage errors.
  }
}

function isInitialized(scope: string) {
  const storage = getStorage();
  if (!storage) return false;
  return storage.getItem(scopedKey(scope, MANUAL_TOKENS_INIT_KEY)) === '1';
}

export function loadManualTokens(scope: string) {
  return normalizeItems(readJson<AddressItem[]>(scope, MANUAL_TOKENS_KEY, []));
}

export function saveManualTokens(scope: string, items: AddressItem[]) {
  const normalized = normalizeItems(items);
  writeJson(scope, MANUAL_TOKENS_KEY, normalized);
  markInitialized(scope);
  return normalized;
}

export function resolveScopedManualTokens(scope: string, backendTokens: AddressItem[]) {
  const localTokens = loadManualTokens(scope);
  if (isInitialized(scope)) {
    return localTokens;
  }

  const initialTokens = localTokens.length > 0 ? localTokens : normalizeItems(backendTokens);
  saveManualTokens(scope, initialTokens);
  return initialTokens;
}
