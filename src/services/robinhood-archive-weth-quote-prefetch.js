'use strict';

const {
  createRobinhoodWethUsdQuoteReader, SLOT0_SELECTOR, LIQUIDITY_SELECTOR,
} = require('./robinhood-weth-usd-quote');

function createRobinhoodArchiveWethQuotePrefetch(options) {
  const { rpcClient, batchSize = 100, concurrency = 2 } = options;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new RangeError('quote prefetch requires batchSize 1..100 and concurrency 1..8');
  }
  // This cache belongs to one bounded repair batch, never to a live reader.
  const state = new Map();
  const key = (method, params) => JSON.stringify([method, params]);
  const reader = createRobinhoodWethUsdQuoteReader({
    rpcClient: { request: async (method, params, requestOptions) => {
      const identity = key(method, params);
      if (state.has(identity)) return state.get(identity);
      return rpcClient.request(method, params, requestOptions);
    } },
  });

  async function prefetch(blockTags) {
    state.clear();
    const tags = [...new Set(blockTags)];
    if (tags.length > 500) throw new RangeError('quote prefetch supports at most 500 blocks');
    const metrics = { blocks: tags.length, calls: 0, batches: 0, failedBatches: 0, cachedCalls: 0 };
    if (!tags.length || typeof rpcClient.requestBatch !== 'function') return metrics;
    let pools;
    try {
      pools = await reader.syncReferencePools();
    } catch (_) {
      // Leave normal snapshot reads responsible for their existing error/fallback policy.
      metrics.failedBatches = 1;
      return metrics;
    }
    const requests = tags.flatMap((tag) => pools
      .filter((pool) => BigInt(tag) >= pool.deploymentBlock)
      .flatMap((pool) => [SLOT0_SELECTOR, LIQUIDITY_SELECTOR].map((data) => ({
        method: 'eth_call', params: [{ to: pool.poolAddress, data }, tag],
      }))));
    metrics.calls = requests.length;
    const batches = [];
    for (let offset = 0; offset < requests.length; offset += batchSize) {
      batches.push(requests.slice(offset, offset + batchSize));
    }
    let next = 0;
    let unsupported = false;
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length && !unsupported) {
        const batch = batches[next++];
        try {
          const values = await rpcClient.requestBatch(batch);
          if (!Array.isArray(values) || values.length !== batch.length) {
            throw new Error('quote batch returned an invalid result count');
          }
          batch.forEach((request, index) => state.set(key(request.method, request.params), values[index]));
          metrics.batches += 1;
          metrics.cachedCalls += batch.length;
        } catch (error) {
          // A batch error does not identify which pool failed. Cache none of it;
          // original individual reads retain partial-pool and event fallbacks.
          metrics.failedBatches += 1;
          if (error?.code === 'batch_unsupported') unsupported = true;
        }
      }
    }));
    return metrics;
  }

  return Object.freeze({ reader, prefetch });
}

module.exports = { createRobinhoodArchiveWethQuotePrefetch };
