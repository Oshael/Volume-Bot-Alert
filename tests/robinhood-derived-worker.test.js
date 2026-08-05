const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const worker = require('../src/services/robinhood-derived-worker');

const RESULT = { reclaimed: 1, claimed: 4, delivered: 3, retried: 1, blocked: 0 };

function fakeRunner() {
  const calls = { count: 0 };
  return { _calls: calls, runOnce: async () => { calls.count += 1; return RESULT; } };
}

function fakeRepo() {
  const calls = { prune: 0 };
  return { _calls: calls, pruneBlocked: async () => { calls.prune += 1; return 2; } };
}

describe('robinhood derived worker', () => {
  it('bounds its runtime options and honours the enabled flag', () => {
    const bounded = worker.__private.normalizeOptions({ intervalMs: 5, pruneIntervalMs: 10 });
    assert.equal(bounded.intervalMs, 50); // clamped up to the floor
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
    assert.equal(status.lastDelivered, 3);
    assert.equal(status.totalDelivered, 3);
    assert.equal(repository._calls.prune, 1);
    assert.equal(status.lastPrunedRows, 2);
  });

  it('does not prune again while still inside the retention window', async () => {
    const repository = fakeRepo();
    const normalized = worker.__private.normalizeOptions({ pruneIntervalMs: 3_600_000 });
    worker.__private.build(normalized, { runner: fakeRunner(), repository });

    await worker.runOnce(normalized);

    assert.equal(repository._calls.prune, 0);
  });

  it('ignores a notification on a foreign channel', () => {
    const before = worker.getStatus().totalNotifies;
    worker.__private.handleNotification({ channel: 'something_else' });
    assert.equal(worker.getStatus().totalNotifies, before);
  });
});
