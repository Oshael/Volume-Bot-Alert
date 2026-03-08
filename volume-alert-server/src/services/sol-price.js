/**
 * SOL Price Service
 * Polls CoinGecko for SOL/USD price, shared across all clients.
 * Server-side fetch — no CORS issues.
 */

const SOL_PRICE_INTERVAL = 60000; // 60s between fetches
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

let solPrice = 0;
let lastFetch = 0;
let fetchTimer = null;

async function fetchSolPrice() {
  try {
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) {
      console.error(`[SOL Price] CoinGecko error: ${res.status}`);
      return;
    }
    const data = await res.json();
    if (data?.solana?.usd) {
      solPrice = data.solana.usd;
      lastFetch = Date.now();
      console.log(`[SOL Price] $${solPrice}`);
    }
  } catch (err) {
    console.error('[SOL Price] Fetch error:', err.message);
  }
}

function start() {
  // Fetch immediately, then every interval
  fetchSolPrice();
  fetchTimer = setInterval(fetchSolPrice, SOL_PRICE_INTERVAL);
  console.log(`[SOL Price] Polling every ${SOL_PRICE_INTERVAL / 1000}s`);
}

function stop() {
  if (fetchTimer) {
    clearInterval(fetchTimer);
    fetchTimer = null;
  }
}

function getPrice() {
  return solPrice;
}

function getStatus() {
  return {
    price: solPrice,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    age: lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null,
  };
}

module.exports = { start, stop, getPrice, getStatus };
