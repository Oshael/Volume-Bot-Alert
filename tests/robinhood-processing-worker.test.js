const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const worker = require('../src/services/robinhood-processing-worker');

const RESULT = { reclaimed: 1, claimed: 4, processed: 3, rejected: 1, retried: 0, blocked: 0 };

function fakeRunner() {
  const calls = { count: 0 };
  return { _calls: calls, runOnce: async () => { calls.count += 1; return RESULT; } };
}

function fakeRepo() {
  const calls = { prune: 0 };
  return { _calls: calls, pruneExpiredCaptures: async () => { calls.prune += 1; return 3; } };
}

describe('robinhood processing worker', () => {
  it('bounds its runtime options and honours the enabled flag', () => {
    const bounded = worker.__private.normalizeOptions({ intervalMs: 5, pruneIntervalMs: 10 });
    assert.equal(bounded.intervalMs, 100); // clamped up to the floor
    assert.equal(bounded.pruneIntervalMs, 30_000); // clamped up to the floor
    assert.equal(bounded.enabled, true);
    assert.equal(worker.__private.normalizeOptions({ enabled: false }).enabled, false);
  });

  // Runs first so the module-level prune clock is still at its initial zero.
  it('runs a tick, aggregates counts into status, and prunes when the window is due', async () => {
    const repository = fakeRepo();
    const normalized = worker.__private.normalizeOptions({});
    worker.__private.build(normalized, { runner: fakeRunner(), repository });

    const result = await worker.runOnce(normalized);

    assert.deepEqual(result, RESULT);
    const status = worker.getStatus();
    assert.equal(status.lastProcessed, 3);
    assert.equal(status.totalProcessed, 3);
    assert.equal(repository._calls.prune, 1);
    assert.equal(status.lastPrunedCaptures, 3);
  });

  it('does not prune again while still inside the retention window', async () => {
    const repository = fakeRepo();
    const normalized = worker.__private.normalizeOptions({ pruneIntervalMs: 3_600_000 });
    worker.__private.build(normalized, { runner: fakeRunner(), repository });

    await worker.runOnce(normalized);

    assert.equal(repository._calls.prune, 0);
  });
});
