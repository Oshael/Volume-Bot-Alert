/**
 * SOL Price Service
 * Polls CoinGecko for SOL/USD price, shared across all clients.
 * Server-side fetch with cooldown/backoff when CoinGecko returns 429.
 */

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const REQUEST_TIMEOUT_MS = 10000;
const BASE_INTERVAL_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

let solPrice = 0;
let lastFetch = 0;
let fetchTimer = null;
let running = false;
let nextFetchAt = 0;
let consecutive429s = 0;
let lastError = null;

function clampDelayMs(value, fallback = BASE_INTERVAL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(MAX_BACKOFF_MS, Math.max(1000, Math.round(parsed)));
}

function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return clampDelayMs(seconds * 1000);
  }

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return null;
  }

  return clampDelayMs(at - now);
}

function computeBackoffMs(retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return clampDelayMs(retryAfterMs);
  }

  const exponent = Math.max(0, Math.min(6, consecutive429s - 1));
  return clampDelayMs(BASE_INTERVAL_MS * (2 ** exponent));
}

function scheduleNextFetch(delayMs = BASE_INTERVAL_MS) {
  if (!running) return;
  if (fetchTimer) {
    clearTimeout(fetchTimer);
    fetchTimer = null;
  }

  const safeDelayMs = clampDelayMs(delayMs);
  nextFetchAt = Date.now() + safeDelayMs;
  fetchTimer = setTimeout(() => {
    fetchTimer = null;
    void fetchSolPrice();
  }, safeDelayMs);
}

async function fetchSolPrice() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(COINGECKO_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'VolumeAlertBot/1.0',
      },
    });

    if (res.status === 429) {
      consecutive429s += 1;
      lastError = 'rate_limited';
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const backoffMs = computeBackoffMs(retryAfterMs);
      console.warn(`[SOL Price] CoinGecko 429; backing off for ${Math.round(backoffMs / 1000)}s`);
      scheduleNextFetch(backoffMs);
      return;
    }

    if (!res.ok) {
      lastError = `http_${res.status}`;
      console.error(`[SOL Price] CoinGecko error: ${res.status}`);
      scheduleNextFetch(BASE_INTERVAL_MS);
      return;
    }

    const data = await res.json();
    if (data?.solana?.usd) {
      solPrice = data.solana.usd;
      lastFetch = Date.now();
      consecutive429s = 0;
      lastError = null;
      console.log(`[SOL Price] $${solPrice}`);
    }

    scheduleNextFetch(BASE_INTERVAL_MS);
  } catch (err) {
    lastError = err?.name === 'AbortError' ? 'timeout' : 'fetch_error';
    console.error('[SOL Price] Fetch error:', err.message);
    scheduleNextFetch(BASE_INTERVAL_MS);
  } finally {
    clearTimeout(timeout);
  }
}

function start() {
  if (running) return;
  running = true;
  console.log(`[SOL Price] Polling every ${BASE_INTERVAL_MS / 1000}s with 429 backoff`);
  void fetchSolPrice();
}

function stop() {
  running = false;
  if (fetchTimer) {
    clearTimeout(fetchTimer);
    fetchTimer = null;
  }
  nextFetchAt = 0;
}

function getPrice() {
  return solPrice;
}

function getStatus() {
  return {
    price: solPrice,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    age: lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null,
    consecutive429s,
    lastError,
    nextFetchAt: nextFetchAt ? new Date(nextFetchAt).toISOString() : null,
    nextFetchInSeconds: nextFetchAt ? Math.max(0, Math.round((nextFetchAt - Date.now()) / 1000)) : null,
  };
}

module.exports = { start, stop, getPrice, getStatus };
