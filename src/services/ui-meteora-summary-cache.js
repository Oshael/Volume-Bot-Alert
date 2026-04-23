const config = require('../../config');
const tokenMeteoraState = require('../models/token-meteora-state');

const summaryCache = new Map();
const inFlightRequests = new Map();
const MAX_CACHE_ENTRIES = 128;

function normalizeAddresses(addresses = []) {
  return Array.from(
    new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((address) => String(address || '').trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function getTtlMs() {
  const ttlMs = Number(config.db.uiMeteoraSummaryCacheMs);
  return Number.isFinite(ttlMs) ? Math.max(0, Math.trunc(ttlMs)) : 0;
}

function buildCacheKey(addresses = []) {
  const normalized = normalizeAddresses(addresses);
  return {
    normalized,
    key: normalized.join(','),
  };
}

function pruneExpiredEntries(now = Date.now()) {
  for (const [key, entry] of summaryCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      summaryCache.delete(key);
    }
  }
}

function enforceCacheLimit() {
  if (summaryCache.size <= MAX_CACHE_ENTRIES) {
    return;
  }

  const oldestEntries = [...summaryCache.entries()]
    .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
    .slice(0, Math.max(0, summaryCache.size - MAX_CACHE_ENTRIES));

  for (const [key] of oldestEntries) {
    summaryCache.delete(key);
  }
}

async function listUiSummaryByAddresses(addresses = []) {
  const { normalized, key } = buildCacheKey(addresses);
  if (normalized.length === 0) {
    return [];
  }

  const ttlMs = getTtlMs();
  if (ttlMs <= 0) {
    return tokenMeteoraState.listSummaryByAddresses(normalized);
  }

  const now = Date.now();
  pruneExpiredEntries(now);

  const cached = summaryCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.rows;
  }

  const inFlight = inFlightRequests.get(key);
  if (inFlight) {
    return inFlight;
  }

  const request = tokenMeteoraState.listSummaryByAddresses(normalized)
    .then((rows) => {
      summaryCache.set(key, {
        rows,
        expiresAt: Date.now() + ttlMs,
      });
      enforceCacheLimit();
      return rows;
    })
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, request);
  return request;
}

function clearUiMeteoraSummaryCache() {
  summaryCache.clear();
  inFlightRequests.clear();
}

module.exports = {
  listUiSummaryByAddresses,
  clearUiMeteoraSummaryCache,
  __private: {
    buildCacheKey,
    getTtlMs,
  },
};
