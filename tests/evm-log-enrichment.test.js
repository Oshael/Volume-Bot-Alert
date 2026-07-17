const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createBlockTimestampEnricher } = require('../src/services/evm-log-enrichment');

function deferredClient(options = {}) {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  return {
    calls,
    get maxActive() { return maxActive; },
    request: async (_method, [blockNumber]) => {
      calls.push(blockNumber);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      if (blockNumber === options.failBlock) throw new Error('timestamp failure');
      return { timestamp: `0x${(1000 + Number(BigInt(blockNumber))).toString(16)}` };
    },
  };
}

function log(blockNumber, logIndex) {
  return { blockNumber, logIndex, blockTimestamp: '0x0' };
}

describe('EVM log timestamp enrichment', () => {
  it('fetches unique blocks with bounded concurrency and preserves log order', async () => {
    const rpcClient = deferredClient();
    const enricher = createBlockTimestampEnricher({ rpcClient, concurrency: 2 });
    const logs = [log('0x1', '0x0'), log('0x2', '0x1'), log('0x1', '0x2'), log('0x3', '0x3')];
    const enriched = await enricher.enrich(logs);

    assert.deepEqual(enriched.map((entry) => entry.logIndex), ['0x0', '0x1', '0x2', '0x3']);
    assert.equal(rpcClient.calls.length, 3);
    assert.equal(rpcClient.maxActive, 2);
    assert.deepEqual(enriched.map((entry) => entry.blockTimestamp), ['0x3e9', '0x3ea', '0x3e9', '0x3eb']);
    assert.deepEqual(enricher.snapshot(), {
      batches: 1,
      blocksRequested: 3,
      cacheHits: 0,
      maxBatchBlocks: 3,
      maxActive: 2,
      rpcBatchRequests: 0,
      batchFallbacks: 0,
      concurrency: 2,
      batchSize: 10,
      batchConcurrency: 1,
      batchEnabled: false,
    });
  });

  it('fetches block timestamps in bounded JSON-RPC batches', async () => {
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const rpcClient = {
      request: async () => { throw new Error('individual request should not run'); },
      requestBatch: async (requests) => {
        calls.push(requests);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return requests.map(({ params }) => ({
          timestamp: `0x${(1000 + Number(BigInt(params[0]))).toString(16)}`,
        }));
      },
    };
    const enricher = createBlockTimestampEnricher({
      rpcClient,
      batchSize: 10,
      batchConcurrency: 2,
    });
    const logs = Array.from({ length: 25 }, (_, index) => log(`0x${(index + 1).toString(16)}`, '0x0'));

    const enriched = await enricher.enrich(logs);

    assert.deepEqual(calls.map((batch) => batch.length), [10, 10, 5]);
    assert.equal(maxActive, 2);
    assert.equal(enriched[24].blockTimestamp, '0x401');
    assert.equal(enricher.snapshot().rpcBatchRequests, 3);
    assert.equal(enricher.snapshot().blocksRequested, 25);
  });

  it('falls back once to individual requests when JSON-RPC batching is unsupported', async () => {
    let batchCalls = 0;
    const rpcClient = deferredClient();
    rpcClient.requestBatch = async () => {
      batchCalls += 1;
      throw Object.assign(new Error('batch unsupported'), { code: 'batch_unsupported' });
    };
    const enricher = createBlockTimestampEnricher({ rpcClient, concurrency: 2 });

    await enricher.enrich([log('0x1', '0x0'), log('0x2', '0x1')]);
    await enricher.enrich([log('0x3', '0x2')]);

    assert.equal(batchCalls, 1);
    assert.equal(rpcClient.calls.length, 3);
    assert.equal(enricher.snapshot().batchFallbacks, 1);
    assert.equal(enricher.snapshot().batchEnabled, false);
  });

  it('reuses cached timestamps without another RPC call', async () => {
    const rpcClient = deferredClient();
    const enricher = createBlockTimestampEnricher({ rpcClient, concurrency: 2 });
    await enricher.enrich([log('0x1', '0x0')]);
    const enriched = await enricher.enrich([log('0x1', '0x1')]);

    assert.equal(rpcClient.calls.length, 1);
    assert.equal(enriched[0].blockTimestamp, '0x3e9');
  });

  it('rejects the whole batch when a block timestamp cannot be fetched', async () => {
    const rpcClient = deferredClient({ failBlock: '0x2' });
    const enricher = createBlockTimestampEnricher({ rpcClient, concurrency: 2 });

    await assert.rejects(enricher.enrich([log('0x1', '0x0'), log('0x2', '0x1')]), /timestamp failure/);
  });
});
