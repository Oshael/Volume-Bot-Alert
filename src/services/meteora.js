const { isValidAddress } = require('../models/user-token');

const DEFAULT_CHUNK_SIZE = 15;
const DEFAULT_DELAY_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMeteoraBulk(addresses, options = {}) {
  const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || DEFAULT_CHUNK_SIZE, 50));
  const delayMs = Math.max(0, Number(options.delayMs) || DEFAULT_DELAY_MS);
  const uniqueAddresses = [...new Set((addresses || []).map((value) => String(value || '').trim()).filter((value) => isValidAddress(value)))];
  const results = {};

  for (let index = 0; index < uniqueAddresses.length; index += chunkSize) {
    const chunk = uniqueAddresses.slice(index, index + chunkSize);
    const params = new URLSearchParams({
      page: '0',
      limit: '100',
      sort_key: 'tvl',
      order_by: 'desc',
    });

    for (const address of chunk) {
      params.append('include_token_mints', address);
    }

    try {
      const response = await fetch(`https://dlmm-api.meteora.ag/pair/all_by_groups?${params.toString()}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const allPairs = (data?.groups || []).flatMap((group) => group?.pairs || []);
      for (const address of chunk) {
        const relevant = allPairs.filter((pair) => pair?.mint_x === address || pair?.mint_y === address);
        if (relevant.length === 0) {
          continue;
        }

        let totalTvl = 0;
        let bestPool = null;
        let bestTvl = 0;

        for (const pair of relevant) {
          const tvl = Number(pair?.liquidity) || 0;
          totalTvl += tvl;
          if (tvl > bestTvl) {
            bestTvl = tvl;
            bestPool = typeof pair?.address === 'string' ? pair.address : null;
          }
        }

        results[address] = {
          tvl: totalTvl,
          poolAddress: bestPool,
          poolCount: relevant.length,
          source: 'meteora',
        };
      }
    } catch (_) {
      // Ignore this chunk and continue with the next one.
    }

    if (delayMs > 0 && index + chunkSize < uniqueAddresses.length) {
      await sleep(delayMs);
    }
  }

  return results;
}

module.exports = {
  fetchMeteoraBulk,
};
