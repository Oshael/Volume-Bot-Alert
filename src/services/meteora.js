const { isValidAddress } = require('../models/user-token');

const DLMM_API_BASE_URL = 'https://dlmm.datapi.meteora.ag';
const DEFAULT_CHUNK_SIZE = 1;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddresses(addresses) {
  return [...new Set(
    (addresses || [])
      .map((value) => String(value || '').trim())
      .filter((value) => isValidAddress(value))
  )];
}

function buildChunkParams(chunk) {
  const tokenFilter = `[${chunk.join('|')}]`;
  const params = new URLSearchParams({
    page: '1',
    page_size: '1000',
    sort_by: 'tvl:desc',
  });
  params.set('filter_by', `token_x=${tokenFilter}`);

  return params;
}

function buildChunkSideParams(chunk, side) {
  if (side !== 'token_x' && side !== 'token_y') {
    throw new Error('Unsupported Meteora token side');
  }

  const params = buildChunkParams(chunk);
  params.set('filter_by', `${side}=[${chunk.join('|')}]`);
  return params;
}

function markChunkError(errorsByAddress, chunk, message) {
  for (const address of chunk) {
    errorsByAddress[address] = message;
  }
}

function collectChunkResults(chunk, allPairs, results) {
  for (const address of chunk) {
    const relevant = allPairs.filter((pair) => {
      const tokenXAddress = String(pair?.token_x?.address || '').trim();
      const tokenYAddress = String(pair?.token_y?.address || '').trim();
      return tokenXAddress === address || tokenYAddress === address;
    });
    if (relevant.length === 0) {
      continue;
    }

    let totalTvl = 0;
    let bestPool = null;
    let bestTvl = 0;

    for (const pair of relevant) {
      const tvl = Number(pair?.tvl) || 0;
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
}

async function fetchPoolsPage(params) {
  const response = await fetch(`${DLMM_API_BASE_URL}/pools?${params.toString()}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.data) ? data.data : [];
}

async function fetchChunk(chunk, results, checkedAddresses, errorsByAddress) {
  try {
    const [tokenXPools, tokenYPools] = await Promise.all([
      fetchPoolsPage(buildChunkSideParams(chunk, 'token_x')),
      fetchPoolsPage(buildChunkSideParams(chunk, 'token_y')),
    ]);
    const dedupedPairs = new Map();
    for (const pair of [...tokenXPools, ...tokenYPools]) {
      const poolAddress = String(pair?.address || '').trim();
      if (!poolAddress) {
        continue;
      }
      dedupedPairs.set(poolAddress, pair);
    }
    const allPairs = [...dedupedPairs.values()];
    checkedAddresses.push(...chunk);
    collectChunkResults(chunk, allPairs, results);
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : 'Unknown Meteora fetch error';
    markChunkError(errorsByAddress, chunk, message);
  }
}

function chunkAddresses(addresses, chunkSize) {
  const chunks = [];
  for (let index = 0; index < addresses.length; index += chunkSize) {
    chunks.push(addresses.slice(index, index + chunkSize));
  }
  return chunks;
}

async function processChunkWave(chunks, results, checkedAddresses, errorsByAddress) {
  await Promise.all(
    chunks.map((chunk) => fetchChunk(chunk, results, checkedAddresses, errorsByAddress))
  );
}

async function fetchMeteoraBulk(addresses, options = {}) {
  const chunkSize = Math.max(1, Math.min(Number(options.chunkSize) || DEFAULT_CHUNK_SIZE, 50));
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || DEFAULT_CONCURRENCY, 10));
  const delayMs = Math.max(0, Number(options.delayMs) || DEFAULT_DELAY_MS);
  const uniqueAddresses = normalizeAddresses(addresses);
  const results = {};
  const checkedAddresses = [];
  const errorsByAddress = {};
  const chunks = chunkAddresses(uniqueAddresses, chunkSize);

  for (let index = 0; index < chunks.length; index += concurrency) {
    const wave = chunks.slice(index, index + concurrency);
    await processChunkWave(wave, results, checkedAddresses, errorsByAddress);

    if (delayMs > 0 && index + concurrency < chunks.length) {
      await sleep(delayMs);
    }
  }

  return {
    results,
    checkedAddresses,
    errorsByAddress,
  };
}

module.exports = {
  fetchMeteoraBulk,
  __private: {
    buildChunkParams,
    buildChunkSideParams,
    chunkAddresses,
    collectChunkResults,
    fetchPoolsPage,
    fetchChunk,
    markChunkError,
    normalizeAddresses,
    processChunkWave,
  },
};
