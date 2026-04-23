const config = require('../../config');
const tokenMeteoraState = require('../models/token-meteora-state');

const summaryCache = new Map();
const inFlightByAddress = new Map();
const MAX_CACHE_ENTRIES = 2000;

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

function pruneExpiredEntries(now = Date.now()) {
  for (const [address, entry] of summaryCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      summaryCache.delete(address);
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

  for (const [address] of oldestEntries) {
    summaryCache.delete(address);
  }
}

function readFreshCachedRow(address, now) {
  const cached = summaryCache.get(address);
  if (!cached || cached.expiresAt <= now) {
    return undefined;
  }
  return cached.row ?? null;
}

function cacheRows(addresses, rows, ttlMs) {
  const rowsByAddress = new Map((rows || []).map((row) => [row.tokenAddress, row]));
  const expiresAt = Date.now() + ttlMs;

  for (const address of addresses) {
    summaryCache.set(address, {
      row: rowsByAddress.get(address) || null,
      expiresAt,
    });
  }

  enforceCacheLimit();
  return rowsByAddress;
}

function fetchMissingAddresses(addresses, ttlMs) {
  const normalized = normalizeAddresses(addresses);
  if (normalized.length === 0) {
    return Promise.resolve(new Map());
  }

  const batchPromise = tokenMeteoraState.listSummaryByAddresses(normalized)
    .then((rows) => cacheRows(normalized, rows, ttlMs))
    .finally(() => {
      for (const address of normalized) {
        inFlightByAddress.delete(address);
      }
    });

  for (const address of normalized) {
    inFlightByAddress.set(address, batchPromise.then((rowsByAddress) => rowsByAddress.get(address) || null));
  }

  return batchPromise;
}

async function listUiSummaryByAddresses(addresses = []) {
  const normalized = normalizeAddresses(addresses);
  if (normalized.length === 0) {
    return [];
  }

  const ttlMs = getTtlMs();
  if (ttlMs <= 0) {
    return tokenMeteoraState.listSummaryByAddresses(normalized);
  }

  const now = Date.now();
  pruneExpiredEntries(now);

  const pendingRows = new Map();
  const missingAddresses = [];

  for (const address of normalized) {
    const cachedRow = readFreshCachedRow(address, now);
    if (cachedRow !== undefined) {
      pendingRows.set(address, Promise.resolve(cachedRow));
      continue;
    }

    const inFlight = inFlightByAddress.get(address);
    if (inFlight) {
      pendingRows.set(address, inFlight);
      continue;
    }

    missingAddresses.push(address);
  }

  if (missingAddresses.length > 0) {
    const rowsByAddressPromise = fetchMissingAddresses(missingAddresses, ttlMs);
    for (const address of missingAddresses) {
      pendingRows.set(address, rowsByAddressPromise.then((rowsByAddress) => rowsByAddress.get(address) || null));
    }
  }

  const orderedRows = await Promise.all(
    normalized.map((address) => pendingRows.get(address) || Promise.resolve(null))
  );

  return orderedRows.filter(Boolean);
}

function clearUiMeteoraSummaryCache() {
  summaryCache.clear();
  inFlightByAddress.clear();
}

module.exports = {
  listUiSummaryByAddresses,
  clearUiMeteoraSummaryCache,
  __private: {
    getTtlMs,
    normalizeAddresses,
  },
};
