const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MAX_RPC_BATCH_SIZE,
  executeRobinhoodBackfillEnrichmentPlan,
  planRobinhoodBackfillEnrichment,
} = require('../src/services/robinhood-backfill-enrichment-planner');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;

function dependency(slot, value, provider = 'drpc') {
  return {
    slot,
    provider,
    method: 'eth_call',
    params: [{ data: `0x${value}`, to: TOKEN_A }, '0x10'],
  };
}

function item(overrides = {}) {
  return {
    id: overrides.id || 'item-1',
    tokenAddress: overrides.tokenAddress || TOKEN_A,
    blockNumber: overrides.blockNumber ?? '16',
    logIndex: overrides.logIndex ?? '0',
    requests: overrides.requests || [dependency('supply', '01')],
  };
}

function valueFor(method, params) {
  return `${method}:${JSON.stringify(params)}`;
}

function createRpcHarness({ rejectBatch = false } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async request(method, params) {
        calls.push({ transport: 'single', provider: null, method, params });
        return valueFor(method, params);
      },
      async requestProvider(provider, method, params) {
        calls.push({ transport: 'single', provider, method, params });
        return valueFor(method, params);
      },
      async requestBatch(requests) {
        calls.push({ transport: 'batch', provider: null, requests });
        if (rejectBatch) {
          throw Object.assign(new Error('unsupported'), { code: 'batch_unsupported' });
        }
        return requests.map(({ method, params }) => valueFor(method, params));
      },
      async requestBatchProvider(provider, requests) {
        calls.push({ transport: 'batch', provider, requests });
        if (rejectBatch) {
          throw Object.assign(new Error('unsupported'), { code: 'batch_unsupported' });
        }
        return requests.map(({ method, params }) => valueFor(method, params));
      },
    },
  };
}

describe('Robinhood backfill enrichment planner', () => {
  it('orders each token partition and deduplicates canonical RPC dependencies', () => {
    const sharedTimestamp = {
      slot: 'timestamp',
      provider: 'alchemy',
      method: 'eth_getBlockByNumber',
      params: [{ includeTransactions: false, block: '0x10' }],
    };
    const plan = planRobinhoodBackfillEnrichment([
      item({ id: 'b-16', tokenAddress: TOKEN_B, logIndex: 1 }),
      item({
        id: 'a-16-2',
        logIndex: 2,
        requests: [dependency('supply', '01'), sharedTimestamp],
      }),
      item({
        id: 'a-16-1',
        logIndex: 1,
        requests: [
          dependency('supply', '01'),
          {
            ...sharedTimestamp,
            params: [{ block: '0x10', includeTransactions: false }],
          },
        ],
      }),
      item({ id: 'a-15', blockNumber: '0xf', logIndex: 9 }),
    ]);

    assert.deepEqual(plan.items.map(({ id }) => id), ['a-15', 'a-16-1', 'a-16-2', 'b-16']);
    assert.equal(plan.calls.length, 2);
    assert.equal(plan.items[1].dependencies[0].callId, plan.items[2].dependencies[0].callId);
    assert.equal(plan.items[1].dependencies[1].callId, plan.items[2].dependencies[1].callId);
  });

  it('adapts batches to provider limits without exceeding the client ceiling', () => {
    const cases = [
      { configured: 250, expected: [MAX_RPC_BATCH_SIZE, 1] },
      { configured: 40, expected: [40, 40, 21] },
      { configured: 1, expected: Array(101).fill(1) },
    ];
    for (const { configured, expected } of cases) {
      const requests = Array.from({ length: 101 }, (_, index) => (
        dependency(`call-${index}`, index.toString(16).padStart(2, '0'), 'alchemy')
      ));
      const plan = planRobinhoodBackfillEnrichment(
        [item({ requests })],
        { batchSize: 100, providerBatchSizes: { alchemy: configured } }
      );
      assert.deepEqual(plan.batches.map(({ calls }) => calls.length), expected);
      assert.ok(plan.batches.every(({ calls }) => calls.length <= MAX_RPC_BATCH_SIZE));
    }
  });

  it('returns the same ordered fan-out for individual and batch transports', async () => {
    const plan = planRobinhoodBackfillEnrichment([
      item({
        id: 'second',
        tokenAddress: TOKEN_B,
        requests: [dependency('supply', '02'), dependency('metadata', '03')],
      }),
      item({
        id: 'first',
        requests: [dependency('supply', '01'), dependency('metadata', '03')],
      }),
    ]);
    const batchedHarness = createRpcHarness();
    const individualHarness = createRpcHarness();
    const batched = await executeRobinhoodBackfillEnrichmentPlan(
      plan, batchedHarness.client
    );
    const individual = await executeRobinhoodBackfillEnrichmentPlan(
      plan, individualHarness.client, { useBatch: false }
    );

    assert.deepEqual(batched.items, individual.items);
    assert.deepEqual(batched.items.map(({ id }) => id), ['first', 'second']);
    assert.equal(batchedHarness.calls.length, 1);
    assert.equal(batchedHarness.calls[0].requests.length, 3);
    assert.equal(individualHarness.calls.length, 3);
    assert.deepEqual(batched.metrics, {
      batches: 1,
      batchItems: 3,
      individualRequests: 0,
      batchFallbacks: 0,
    });
  });

  it('falls back to individual calls only when the provider rejects JSON-RPC batch', async () => {
    const plan = planRobinhoodBackfillEnrichment([
      item({ requests: [
        dependency('one', '01'), dependency('two', '02'),
        dependency('three', '03'), dependency('four', '04'),
      ] }),
    ], { providerBatchSizes: { drpc: 2 } });
    const harness = createRpcHarness({ rejectBatch: true });
    const result = await executeRobinhoodBackfillEnrichmentPlan(plan, harness.client);

    assert.equal(harness.calls[0].transport, 'batch');
    assert.deepEqual(
      harness.calls.slice(1).map(({ transport }) => transport),
      ['single', 'single', 'single', 'single']
    );
    assert.equal(result.metrics.batchFallbacks, 1);
    assert.equal(result.metrics.individualRequests, 4);
  });

  it('rejects ambiguous identities and invalid provider limits before execution', () => {
    assert.throws(
      () => planRobinhoodBackfillEnrichment([item(), item()]),
      /Duplicate enrichment item id/
    );
    assert.throws(
      () => planRobinhoodBackfillEnrichment([
        item({ requests: [dependency('same', '01'), dependency('same', '02')] }),
      ]),
      /repeats slot same/
    );
    assert.throws(
      () => planRobinhoodBackfillEnrichment([item()], {
        providerBatchSizes: { drpc: 0 },
      }),
      /positive integer/
    );
  });
});
