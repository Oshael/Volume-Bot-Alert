const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const REQUEST_TIMEOUT = 10000;
const CACHE_TTL_MS = 40000;
const ERROR_COOLDOWN_MS = 15000;

const tokenCache = new Map();
const inFlightRequests = new Map();

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

async function fetchTokenPairsUncached(address) {
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
    setCacheEntry(address, data, CACHE_TTL_MS);
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

async function getTokenPairs(address) {
  const addr = String(address || '').trim();
  if (!addr) return null;

  const cached = getCacheEntry(addr);
  if (cached) return cached.data;

  const inFlight = inFlightRequests.get(addr);
  if (inFlight) return inFlight;

  const request = fetchTokenPairsUncached(addr)
    .finally(() => {
      inFlightRequests.delete(addr);
    });

  inFlightRequests.set(addr, request);
  return request;
}

async function batchGetTokens(addresses, delayMs = 100) {
  const results = new Map();

  for (const addr of addresses) {
    const data = await getTokenPairs(addr);
    if (data) {
      results.set(addr, data);
    }
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
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
}

module.exports = {
  getTokenPairs,
  batchGetTokens,
  getBestPair,
  clearCache,
};
