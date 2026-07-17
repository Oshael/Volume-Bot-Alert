function validTimestamp(value) {
  const raw = String(value ?? '');
  return (/^0x[0-9a-f]+$/i.test(raw) || /^\d+$/.test(raw)) && BigInt(raw) > 0n;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  const workerCount = Math.min(items.length, Math.max(1, Number(concurrency) || 1));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function createBlockTimestampEnricher(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const concurrency = Math.max(1, Number(options.concurrency) || 16);
  const batchSize = Math.max(1, Math.min(100, Number(options.batchSize) || 10));
  const batchConcurrency = Math.max(1, Math.min(4, Number(options.batchConcurrency) || 1));
  const maxCacheEntries = Math.max(1, Number(options.maxCacheEntries) || 512);
  const cache = new Map();
  const pending = new Map();
  const metrics = {
    batches: 0,
    blocksRequested: 0,
    cacheHits: 0,
    maxBatchBlocks: 0,
    maxActive: 0,
    rpcBatchRequests: 0,
    batchFallbacks: 0,
  };
  let batchEnabled = typeof options.rpcClient.requestBatch === 'function';
  let active = 0;

  function cacheTimestamp(blockNumber, timestamp) {
    cache.set(blockNumber, timestamp);
    if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  async function getTimestamp(blockNumber) {
    if (cache.has(blockNumber)) {
      metrics.cacheHits += 1;
      return cache.get(blockNumber);
    }
    if (pending.has(blockNumber)) {
      metrics.cacheHits += 1;
      return pending.get(blockNumber);
    }
    const request = (async () => {
      active += 1;
      metrics.blocksRequested += 1;
      metrics.maxActive = Math.max(metrics.maxActive, active);
      try {
        const block = await options.rpcClient.request('eth_getBlockByNumber', [blockNumber, false]);
        if (!validTimestamp(block?.timestamp)) throw new Error(`Block ${blockNumber} has no timestamp`);
        cacheTimestamp(blockNumber, block.timestamp);
        return block.timestamp;
      } finally {
        active -= 1;
        pending.delete(blockNumber);
      }
    })();
    pending.set(blockNumber, request);
    return request;
  }

  async function getTimestampBatch(blockNumbers) {
    active += 1;
    metrics.blocksRequested += blockNumbers.length;
    metrics.rpcBatchRequests += 1;
    metrics.maxActive = Math.max(metrics.maxActive, active);
    try {
      const blocks = await options.rpcClient.requestBatch(blockNumbers.map((blockNumber) => ({
        method: 'eth_getBlockByNumber',
        params: [blockNumber, false],
      })));
      if (!Array.isArray(blocks) || blocks.length !== blockNumbers.length) {
        throw new Error('Block timestamp batch returned an invalid result count');
      }
      for (let index = 0; index < blockNumbers.length; index += 1) {
        const timestamp = blocks[index]?.timestamp;
        if (!validTimestamp(timestamp)) {
          throw new Error(`Block ${blockNumbers[index]} has no timestamp`);
        }
        cacheTimestamp(blockNumbers[index], timestamp);
      }
    } finally {
      active -= 1;
    }
  }

  function chunks(items, size) {
    const output = [];
    for (let index = 0; index < items.length; index += size) {
      output.push(items.slice(index, index + size));
    }
    return output;
  }

  async function fetchMissingBlocks(missingBlocks) {
    if (!batchEnabled) {
      await mapWithConcurrency(missingBlocks, concurrency, getTimestamp);
      return;
    }
    try {
      await mapWithConcurrency(chunks(missingBlocks, batchSize), batchConcurrency, getTimestampBatch);
    } catch (error) {
      if (error?.code !== 'batch_unsupported') throw error;
      batchEnabled = false;
      metrics.batchFallbacks += 1;
      await mapWithConcurrency(missingBlocks, concurrency, getTimestamp);
    }
  }

  async function enrich(logs) {
    const missingBlocks = [...new Set(logs
      .filter((log) => !validTimestamp(log?.blockTimestamp))
      .map((log) => String(log.blockNumber)))]
      .filter((blockNumber) => !cache.has(blockNumber));
    if (missingBlocks.length) {
      metrics.batches += 1;
      metrics.maxBatchBlocks = Math.max(metrics.maxBatchBlocks, missingBlocks.length);
      await fetchMissingBlocks(missingBlocks);
    }
    return logs.map((log) => validTimestamp(log?.blockTimestamp)
      ? log
      : { ...log, blockTimestamp: cache.get(String(log.blockNumber)) });
  }

  return Object.freeze({
    enrich,
    snapshot: () => ({
      ...metrics,
      concurrency,
      batchSize,
      batchConcurrency,
      batchEnabled,
    }),
  });
}

module.exports = { createBlockTimestampEnricher, mapWithConcurrency, validTimestamp };
