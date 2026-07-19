const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildRobinhoodCatalogProjectionTelemetry,
  createRobinhoodCatalogProjectionWorker,
  __private,
} = require('../src/services/robinhood-catalog-projection-worker');

function scheduler() {
  const scheduled = [];
  const cancelled = [];
  return {
    scheduled,
    cancelled,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule(timer) { cancelled.push(timer); },
  };
}

describe('Robinhood catalog projection worker', () => {
  it('does not schedule while disabled', () => {
    const clock = scheduler();
    const worker = createRobinhoodCatalogProjectionWorker(clock);

    assert.equal(worker.start({ enabled: false }), false);
    assert.equal(clock.scheduled.length, 0);
  });

  it('runs projection independently with bounded options and lease telemetry', async () => {
    const clock = scheduler();
    const calls = [];
    const worker = createRobinhoodCatalogProjectionWorker({
      ...clock,
      batch: {
        async runOnce(input) {
          calls.push(input);
          return {
            status: 'completed', candidates: 8, projected: 8,
            onchainResolved: 3, socialEnqueued: 2, demoted: 1,
          };
        },
      },
    });

    assert.equal(worker.start({
      enabled: true, intervalMs: 90000,
      maxTokens: 9999, concurrency: 99, statementTimeoutMs: 500,
    }), true);
    await clock.scheduled[0].callback();

    assert.deepEqual(calls[0], {
      maxTokens: 25,
      concurrency: 10,
      statementTimeoutMs: 1000,
      blockscoutBatchSize: 10,
      socialDrainLimit: 1,
    });
    assert.equal(clock.scheduled[1].delayMs, 90000);
    const telemetry = buildRobinhoodCatalogProjectionTelemetry(
      worker.getStatus(), () => Date.parse('2026-07-14T18:00:00Z')
    );
    assert.equal(telemetry.lastSummary.projected, 8);
    assert.equal(telemetry.lastSummary.demoted, 1);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('backs off after a projection failure and recovers', async () => {
    const clock = scheduler();
    let attempts = 0;
    const errors = [];
    const worker = createRobinhoodCatalogProjectionWorker({
      ...clock,
      logger: { error: (value) => errors.push(value) },
      batch: {
        async runOnce() {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary projection failure');
          return { status: 'completed', candidates: 0, projected: 0 };
        },
      },
    });

    worker.start({ enabled: true, intervalMs: 60000, maxErrorBackoffMs: 240000 });
    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 120000);
    assert.equal(worker.getStatus().consecutiveErrors, 1);
    assert.match(errors[0], /temporary projection failure/);

    await clock.scheduled[1].callback();
    assert.equal(clock.scheduled[2].delayMs, 60000);
    assert.equal(worker.getStatus().consecutiveErrors, 0);
    await worker.stop();
  });

  it('validates the RPC chain before constructing metadata services', async () => {
    const order = [];
    const rpcClient = { providers: ['robinhood-public'] };
    const batch = await __private.createDefaultBatch({
      rpcOptions: { publicRpcUrl: 'https://rpc.example' },
      socialMetadataEnabled: true,
    }, {
      rpcClientFactory: () => { order.push('rpc'); return rpcClient; },
      validateProviderChainIds: async (value) => {
        assert.equal(value, rpcClient);
        order.push('validate');
      },
      metadataReaderFactory: ({ rpcClient: value }) => {
        assert.equal(value, rpcClient);
        order.push('erc20');
        return { getMetadata: async () => null };
      },
      metadataStoreFactory: () => { order.push('store'); return {}; },
      socialQueueFactory: ({ store }) => {
        assert.deepEqual(store, {});
        order.push('social');
        return {};
      },
      batchFactory: (options) => { order.push('batch'); return options; },
    });

    assert.deepEqual(order, ['rpc', 'validate', 'erc20', 'store', 'social', 'batch']);
    assert.ok(batch.metadataReader);
    assert.ok(batch.socialQueue);
  });
});
