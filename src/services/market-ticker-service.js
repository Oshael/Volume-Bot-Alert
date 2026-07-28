const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'HYPE', 'PUMP'];
const CACHE_TTL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;

let cache = null;
let cacheStoredAt = 0;
let requestInFlight = null;

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseMarketTickerPayload(payload, generatedAt = new Date().toISOString()) {
  const [meta, contexts] = Array.isArray(payload) ? payload : [];
  if (!Array.isArray(meta?.universe) || !Array.isArray(contexts)) {
    throw new Error('Hyperliquid market response is malformed');
  }

  const items = SYMBOLS.map((symbol) => {
    const index = meta.universe.findIndex((asset) => asset?.name === symbol);
    const priceUsd = toPositiveNumber(contexts[index]?.markPx);
    const previousPriceUsd = toPositiveNumber(contexts[index]?.prevDayPx);
    if (index < 0 || priceUsd == null || previousPriceUsd == null) {
      throw new Error(`Hyperliquid market response is missing ${symbol}`);
    }
    return {
      symbol,
      priceUsd,
      change24hPct: ((priceUsd - previousPriceUsd) / previousPriceUsd) * 100,
    };
  });

  return { source: 'hyperliquid', generatedAt, stale: false, items };
}

async function requestMarketTicker(fetchImpl, now) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Hyperliquid market request failed with ${response.status}`);
    }
    return parseMarketTickerPayload(await response.json(), new Date(now).toISOString());
  } finally {
    clearTimeout(timeout);
  }
}

async function getMarketTicker(options = {}) {
  const now = options.now ?? Date.now();
  if (cache && (now - cacheStoredAt) < CACHE_TTL_MS) return cache;
  if (!requestInFlight) {
    requestInFlight = requestMarketTicker(options.fetchImpl || global.fetch, now)
      .then((payload) => {
        cache = payload;
        cacheStoredAt = options.now ?? Date.now();
        return payload;
      })
      .finally(() => {
        requestInFlight = null;
      });
  }

  try {
    return await requestInFlight;
  } catch (error) {
    if (cache) return { ...cache, stale: true };
    throw error;
  }
}

function resetCache() {
  cache = null;
  cacheStoredAt = 0;
  requestInFlight = null;
}

module.exports = {
  getMarketTicker,
  __private: { parseMarketTickerPayload, resetCache, SYMBOLS },
};
