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
      rejected: 0,
      fdvRejected: 0,
      lastDurationMs: worker.getStatus().lastDurationMs,
      lastCompletedAt: worker.getStatus().lastCompletedAt,
      lastError: null,
      lastRejectedAddress: null,
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

  it('isolates a permanent numeric overflow without blocking valid snapshots', async () => {
    const scheduler = createSchedule();
    const writtenAddresses = [];
    const worker = createRobinhoodLiveCatalogWorker({
      ...scheduler,
      logger: { error() {} },
      catalog: {
        async applyLiveSnapshots(batch) {
          if (batch.some((row) => row.address === TOKEN)) {
            const error = new Error('numeric field overflow');
            error.code = '22003';
            throw error;
          }
          writtenAddresses.push(...batch.map((row) => row.address));
          return batch.length;
        },
      },
    });
    worker.start({ enabled: true, retryMs: 300 });
    worker.enqueue(update(TOKEN, '2026-07-18T18:00:00.500Z', 1e12, 150000));
    worker.enqueue(update(TOKEN_TWO, '2026-07-18T18:00:00.500Z', 2, 200000));

    await worker.flush();

    assert.deepEqual(writtenAddresses, [TOKEN_TWO]);
    assert.equal(worker.getStatus().pending, 0);
    assert.equal(worker.getStatus().written, 1);
    assert.equal(worker.getStatus().rejected, 1);
    assert.equal(worker.getStatus().errors, 0);
    assert.equal(worker.getStatus().lastRejectedAddress, TOKEN);
    assert.notEqual(scheduler.callbacks.at(-1)?.delayMs, 300);
    await worker.stop();
  });

  it('rejects the 30 billion FDV boundary before scheduling a catalog write', async () => {
    const scheduler = createSchedule();
    let writes = 0;
    const worker = createRobinhoodLiveCatalogWorker({
      ...scheduler,
      catalog: { async applyLiveSnapshots() { writes += 1; return 1; } },
    });
    worker.start({ enabled: true });

    assert.equal(worker.enqueue(
      update(TOKEN, '2026-07-18T18:00:00.500Z', 1, 30_000_000_000)
    ), false);
    assert.equal(worker.getStatus().fdvRejected, 1);
    assert.equal(worker.getStatus().pending, 0);
    assert.equal(writes, 0);
    await worker.stop();
  });
});
