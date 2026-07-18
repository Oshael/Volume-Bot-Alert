const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodLiveCatalogWorker,
} = require('../src/services/robinhood-live-catalog-worker');

const TOKEN = '0x1111111111111111111111111111111111111111';
const TOKEN_TWO = '0x2222222222222222222222222222222222222222';

function update(address, observedAt, priceUsd, fdvUsd) {
  return {
    type: 'market:bucket',
    chain: 'robinhood',
    address,
    generatedAt: observedAt,
    valuation: { observedAt, priceUsd, fdvUsd },
  };
}

function createSchedule() {
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

describe('Robinhood live catalog worker', () => {
  it('coalesces committed updates and writes new and known tokens in one batch', async () => {
    const batches = [];
    const scheduler = createSchedule();
    const worker = createRobinhoodLiveCatalogWorker({
      ...scheduler,
      catalog: {
        async applyLiveSnapshots(batch) {
          batches.push(batch);
          return batch.length;
        },
      },
    });
    worker.start({ enabled: true });

    assert.equal(worker.enqueue(update(
      TOKEN.toUpperCase(), '2026-07-18T18:00:00.100Z', 1, 100000,
    )), true);
    assert.equal(worker.enqueue(update(
      TOKEN, '2026-07-18T18:00:00.500Z', 1.5, 150000,
    )), true);
    assert.equal(worker.enqueue(update(
      TOKEN_TWO, '2026-07-18T18:00:00.300Z', 2, 200000,
    )), true);
    assert.equal(scheduler.callbacks.length, 1);
    assert.equal(scheduler.callbacks[0].delayMs, 25);

    await worker.flush();

    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map((row) => row.address), [TOKEN, TOKEN_TWO]);
    assert.equal(batches[0][0].priceUsd, 1.5);
    assert.equal(batches[0][0].observedAt, '2026-07-18T18:00:00.500Z');
    assert.deepEqual(worker.getStatus(), {
      running: true,
      queued: 3,
      written: 2,
      batches: 1,
      errors: 0,
      lastDurationMs: worker.getStatus().lastDurationMs,
      lastCompletedAt: worker.getStatus().lastCompletedAt,
      lastError: null,
      pending: 0,
    });
    await worker.stop();
  });

  it('restores a failed batch and schedules a bounded retry', async () => {
    const scheduler = createSchedule();
    let attempts = 0;
    const worker = createRobinhoodLiveCatalogWorker({
      ...scheduler,
      logger: { error() {} },
      catalog: {
        async applyLiveSnapshots(batch) {
          attempts += 1;
          if (attempts === 1) throw new Error('database unavailable');
          return batch.length;
        },
      },
    });
    worker.start({ enabled: true, retryMs: 300 });
    worker.enqueue(update(TOKEN, '2026-07-18T18:00:00.500Z', 1.5, 150000));

    await assert.rejects(worker.flush(), /database unavailable/);
    assert.equal(worker.getStatus().pending, 1);
    assert.equal(worker.getStatus().errors, 1);
    assert.equal(scheduler.callbacks.at(-1).delayMs, 300);

    await worker.flush();
    assert.equal(worker.getStatus().pending, 0);
    assert.equal(worker.getStatus().written, 1);
    await worker.stop();
  });
});
