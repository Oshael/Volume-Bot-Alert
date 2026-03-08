/**
 * DexScreener Service
 * Centralized server-side polling for token data.
 * No CORS issues — server fetches directly from DexScreener API.
 *
 * Used for:
 * - Monitored token data (volume, mcap, price changes)
 * - Token pair lookup by address
 */

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const REQUEST_TIMEOUT = 10000; // 10s

/**
 * Fetch token pairs from DexScreener.
 * @param {string} address — token contract address
 * @returns {Object|null} — pair data or null on error
 */
async function getTokenPairs(address) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${address}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`[DexScreener] Error ${res.status} for ${address}`);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[DexScreener] Timeout for ${address}`);
    } else {
      console.error(`[DexScreener] Fetch error for ${address}:`, err.message);
    }
    return null;
  }
}

/**
 * Batch fetch multiple tokens with throttling.
 * @param {string[]} addresses — array of token addresses
 * @param {number} delayMs — delay between requests (default 100ms)
 * @returns {Map<string, Object>} — address → pair data
 */
async function batchGetTokens(addresses, delayMs = 100) {
  const results = new Map();

  for (const addr of addresses) {
    const data = await getTokenPairs(addr);
    if (data) {
      results.set(addr, data);
    }
    // Throttle to avoid rate limiting
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

/**
 * Extract best pair for a given chain from DexScreener response.
 * @param {Object} data — DexScreener response with pairs[]
 * @param {string} chain — chain to filter by (default: 'solana')
 * @returns {Object|null} — best pair (highest liquidity) or null
 */
function getBestPair(data, chain = 'solana') {
  if (!data?.pairs?.length) return null;

  const chainPairs = data.pairs.filter(p => p.chainId === chain);
  if (!chainPairs.length) return null;

  // Sort by liquidity USD descending, pick the best
  return chainPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

module.exports = {
  getTokenPairs,
  batchGetTokens,
  getBestPair,
};
