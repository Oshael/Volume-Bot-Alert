const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodMarketAggregateWorker,
} = require('../src/services/robinhood-market-aggregate-worker');

const TOKEN = '0x1111111111111111111111111111111111111111';
const TOKEN_TWO = '0x2222222222222222222222222222222222222222';
const NOW = Date.parse('2026-07-18T12:08:00.000Z');

function update(address = TOKEN, bucketTs = '2026-07-18T12:07:00.000Z') {
  return { type: 'market:bucket', chain: 'robinhood', address, bucketTs };
}

function createScheduler() {
  const callbacks = [];
  return {
    callbacks,
    cancelSchedule() {},
    schedule(callback, delayMs) {
      callbacks.push({ callback, delayMs });
      return { unref() {} };
    },
  };
}

function emptyRecoveryRepository(overrides = {}) {
  return {
    async listRecentSourceBuckets() { return []; },
    async refreshBucket() {},
    ...overrides,
  };
}

describe('Robinhood market aggregate worker', () => {
  it('coalesces committed minutes and refreshes all parent resolutions with bounded concurrency', async () => {
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = createScheduler();
    const worker = createRobinhoodMarketAggregateWorker({
      ...scheduler,
      now: () => NOW,
      repository: emptyRecoveryRepository({
        async refreshBucket(input) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          calls.push(input);
          active -= 1;
        },
      }),
    });
    worker.start({ enabled: true, concurrency: 2, recoveryLookbackMinutes: 0 });

    assert.equal(worker.enqueue(update(TOKEN.toUpperCase())), true);
    assert.equal(worker.enqueue(update()), true);
    assert.equal(worker.enqueue(update(TOKEN_TWO)), true);
    await worker.flush();

    assert.equal(calls.length, 12);
    assert.equal(maxActive, 2);
    assert.deepEqual(calls.filter((call) => call.tokenAddress === TOKEN).map((call) => (
      [call.granularityMinutes, call.bucketTs]
    )), [
      [5, '2026-07-18T12:05:00.000Z'],
      [15, '2026-07-18T12:00:00.000Z'],
      [30, '2026-07-18T12:00:00.000Z'],
      [60, '2026-07-18T12:00:00.000Z'],
      [240, '2026-07-18T12:00:00.000Z'],
      [1440, '2026-07-18T00:00:00.000Z'],
    ]);
    assert.equal(worker.getStatus().coalesced, 1);
    assert.equal(worker.getStatus().processed, 2);
    assert.equal(worker.getStatus().depth, 0);
    await worker.stop();
  });

  it('retries a failed source bucket without blocking or double-counting successful refreshes', async () => {
    let attempts = 0;
    let currentNow = NOW;
    const scheduler = createScheduler();
    const worker = createRobinhoodMarketAggregateWorker({
      ...scheduler,
      logger: { error() {} },
      now: () => currentNow,
      repository: emptyRecoveryRepository({
        async refreshBucket() {
          attempts += 1;
          if (attempts === 1) throw new Error('database unavailable');
        },
      }),
    });
    worker.start({
      enabled: true, maxRetries: 1, retryMs: 100, recoveryLookbackMinutes: 0,
    });
    worker.enqueue(update());

    await worker.flush();
    assert.equal(worker.getStatus().depth, 1);
    assert.equal(worker.getStatus().failures, 1);
    assert.equal(scheduler.callbacks.at(-1).delayMs, 100);

    currentNow += 100;
    await worker.flush();
    assert.equal(worker.getStatus().processed, 1);
    assert.equal(worker.getStatus().refreshes, 6);
    assert.equal(worker.getStatus().depth, 0);
    await worker.stop();
  });

  it('recovers a bounded recent window and rejects overflow instead of scanning globally', async () => {
    const scheduler = createScheduler();
    const recoveryCalls = [];
    const rows = Array.from({ length: 11 }, (_, index) => ({
      token_address: `0x${String(index + 1).padStart(40, '0')}`,
      bucket_ts: '2026-07-18T12:07:00.000Z',
    }));
    const worker = createRobinhoodMarketAggregateWorker({
      ...scheduler,
      now: () => NOW,
      repository: emptyRecoveryRepository({
        async listRecentSourceBuckets(input) {
          recoveryCalls.push(input);
          return rows;
        },
      }),
    });
    worker.start({
      enabled: true, maxQueueSize: 10, recoveryLookbackMinutes: 15, recoveryLimit: 11,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(recoveryCalls[0].since.toISOString(), '2026-07-18T11:53:00.000Z');
    assert.equal(recoveryCalls[0].limit, 11);
    assert.equal(worker.getStatus().depth, 10);
    assert.equal(worker.getStatus().recovered, 10);
    assert.equal(worker.getStatus().dropped, 1);
    assert.equal(worker.getStatus().oldestPendingAgeMs, 0);
    await worker.stop();
  });
});
