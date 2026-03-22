const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const REQUEST_TIMEOUT = 10000;
const DEFAULT_CACHE_TTL_MS = 60000;
const ERROR_COOLDOWN_MS = 60000;
const TOKEN_BATCH_LIMIT = 30;

const tokenCache = new Map();
const endpointCache = new Map();
const inFlightRequests = new Map();
const endpointInFlightRequests = new Map();

function getCacheEntry(address) {
  const entry = tokenCache.get(address);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    tokenCache.delete(address);
    return null;
  }
  return entry;
}

function setCacheEntry(address, data, ttlMs) {
  tokenCache.set(address, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

function getTokenCacheTtl(priorityHint) {
  switch (String(priorityHint || '').trim().toLowerCase()) {
    case 'high-hot':
      return 5 * 1000;
    case 'high-warm':
      return 5 * 1000;
    case 'high-cold':
      return 5 * 1000;
    case 'normal':
      return 5 * 1000;
    case 'low-near':
      return 20 * 1000;
    case 'low-dust':
      return 10 * 60 * 1000;
    case 'dormant':
      return 30 * 60 * 1000;
    default:
      return DEFAULT_CACHE_TTL_MS;
  }
}

async function fetchTokenPairsUncached(address, priorityHint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${address}`, {
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[DexScreener] Error ${res.status} for ${address}`);
      setCacheEntry(address, null, ERROR_COOLDOWN_MS);
      return null;
    }

    const data = await res.json();
    setCacheEntry(address, data, getTokenCacheTtl(priorityHint));
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[DexScreener] Timeout for ${address}`);
    } else {
      console.error(`[DexScreener] Fetch error for ${address}:`, err.message);
    }
    setCacheEntry(address, null, ERROR_COOLDOWN_MS);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAddress(address) {
  return String(address || '').trim();
}

function buildNormalizedPairsPayload(pairs) {
  return { pairs: Array.isArray(pairs) ? pairs : [] };
}

function getRequestedAddressSet(addresses) {
  return new Set((addresses || []).map((address) => normalizeAddress(address)).filter(Boolean));
}

function groupPairsByAddress(pairs, requestedAddresses) {
  const addressSet = getRequestedAddressSet(requestedAddresses);
  const grouped = new Map();

  for (const address of addressSet) {
    grouped.set(address, []);
  }

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const baseAddress = normalizeAddress(pair?.baseToken?.address);
    const quoteAddress = normalizeAddress(pair?.quoteToken?.address);

    if (addressSet.has(baseAddress)) {
      grouped.get(baseAddress).push(pair);
    }
    if (quoteAddress !== baseAddress && addressSet.has(quoteAddress)) {
      grouped.get(quoteAddress).push(pair);
    }
  }

  return grouped;
}

async function fetchTokenPairsBatchUncached(addresses, options = {}) {
  const normalizedAddresses = [...new Set((addresses || []).map((address) => normalizeAddress(address)).filter(Boolean))];
  const chain = String(options.chain || 'solana').trim() || 'solana';
  const priorityByAddress = options.priorityByAddress instanceof Map
    ? options.priorityByAddress
    : new Map(Object.entries(options.priorityByAddress || {}));
  const results = new Map();

  for (let index = 0; index < normalizedAddresses.length; index += TOKEN_BATCH_LIMIT) {
    const chunk = normalizedAddresses.slice(index, index + TOKEN_BATCH_LIMIT);
    if (chunk.length === 0) continue;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const joinedAddresses = chunk.join(',');
      const res = await fetch(`${DEXSCREENER_BASE}/tokens/v1/${encodeURIComponent(chain)}/${joinedAddresses}`, {
        signal: controller.signal,
      });

      if (!res.ok) {
        console.error(`[DexScreener] Error ${res.status} for batch ${chunk.length} tokens on ${chain}`);
        for (const address of chunk) {
          setCacheEntry(address, null, ERROR_COOLDOWN_MS);
          results.set(address, null);
        }
        continue;
      }

      const pairs = await res.json();
      const groupedPairs = groupPairsByAddress(pairs, chunk);

      for (const address of chunk) {
        const payload = buildNormalizedPairsPayload(groupedPairs.get(address) || []);
        const data = payload.pairs.length > 0 ? payload : null;
        const ttlMs = data
          ? getTokenCacheTtl(priorityByAddress.get(address))
          : ERROR_COOLDOWN_MS;
        setCacheEntry(address, data, ttlMs);
        results.set(address, data);
      }
    } catch (err) {
      const label = err.name === 'AbortError' ? 'Timeout' : 'Fetch error';
      console.error(`[DexScreener] ${label} for batch ${chunk.length} tokens:`, err.message);
      for (const address of chunk) {
        setCacheEntry(address, null, ERROR_COOLDOWN_MS);
        results.set(address, null);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return results;
}

function getEndpointCacheEntry(key) {
  const entry = endpointCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    endpointCache.delete(key);
    return null;
  }
  return entry;
}

function setEndpointCacheEntry(key, data, ttlMs) {
  endpointCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
}

async function fetchEndpointJsonUncached(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(`${DEXSCREENER_BASE}${path}`, {
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[DexScreener] Error ${res.status} for ${path}`);
      setEndpointCacheEntry(path, null, ERROR_COOLDOWN_MS);
      return null;
    }

    const data = await res.json();
    setEndpointCacheEntry(path, data, DEFAULT_CACHE_TTL_MS);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[DexScreener] Timeout for ${path}`);
    } else {
      console.error(`[DexScreener] Fetch error for ${path}:`, err.message);
    }
    setEndpointCacheEntry(path, null, ERROR_COOLDOWN_MS);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getEndpointJson(path) {
  const key = String(path || '').trim();
  if (!key) return null;

  const cached = getEndpointCacheEntry(key);
  if (cached) return cached.data;

  const inFlight = endpointInFlightRequests.get(key);
  if (inFlight) return inFlight;

  const request = fetchEndpointJsonUncached(key)
    .finally(() => {
      endpointInFlightRequests.delete(key);
    });

  endpointInFlightRequests.set(key, request);
  return request;
}

async function getTokenPairs(address, options = {}) {
  const addr = String(address || '').trim();
  if (!addr) return null;

  const cached = getCacheEntry(addr);
  if (cached) return cached.data;

  const inFlight = inFlightRequests.get(addr);
  if (inFlight) return inFlight;

  const request = fetchTokenPairsUncached(addr, options.priority)
    .finally(() => {
      inFlightRequests.delete(addr);
    });

  inFlightRequests.set(addr, request);
  return request;
}

async function batchGetTokens(addresses, delayMs = 100) {
  const options = typeof delayMs === 'object' && delayMs !== null ? delayMs : {};
  const maybeDelayMs = typeof delayMs === 'number' ? delayMs : 0;
  const normalizedAddresses = [...new Set((addresses || []).map((address) => normalizeAddress(address)).filter(Boolean))];
  const results = new Map();
  const missing = [];

  for (const address of normalizedAddresses) {
    const cached = getCacheEntry(address);
    if (cached) {
      results.set(address, cached.data);
    } else {
      missing.push(address);
    }
  }

  if (missing.length > 0) {
    const fetched = await fetchTokenPairsBatchUncached(missing, options);
    for (const [address, data] of fetched.entries()) {
      results.set(address, data);
    }
  }

  if (maybeDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, maybeDelayMs));
  }

  return results;
}

function getBestPair(data, chain = 'solana') {
  if (!data?.pairs?.length) return null;

  const chainPairs = data.pairs.filter(p => p.chainId === chain);
  if (!chainPairs.length) return null;

  return chainPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

function clearCache(address = null) {
  if (address) {
    tokenCache.delete(String(address).trim());
    inFlightRequests.delete(String(address).trim());
    return;
  }
  tokenCache.clear();
  inFlightRequests.clear();
  endpointCache.clear();
  endpointInFlightRequests.clear();
}

function getLatestTokenProfiles() {
  return getEndpointJson('/token-profiles/latest/v1');
}

function getTopTokenBoosts() {
  return getEndpointJson('/token-boosts/top/v1');
}

function getLatestTokenBoosts() {
  return getEndpointJson('/token-boosts/latest/v1');
}

module.exports = {
  getTokenPairs,
  batchGetTokens,
  getBestPair,
  getLatestTokenProfiles,
  getTopTokenBoosts,
  getLatestTokenBoosts,
  clearCache,
};
