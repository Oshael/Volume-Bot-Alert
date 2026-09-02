const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const worker = require('../src/services/robinhood-processing-worker');

const RESULT = {
  reclaimed: 1, claimed: 4, processed: 3, rejected: 1, retried: 0, blocked: 0,
  continuationRounds: 2, continuationClaimed: 2,
  continuationPools: 1,
  timing: { totalMs: 40, prepareMs: 10, persistMs: 20, claimedPerSecond: 100 },
  shadowAudit: { compared: 3, matched: 2, mismatched: 1, missing: 0, errors: 0 },
};

const DISCOVERY_RESULT = {
  reclaimed: 0, claimed: 2, processed: 2, rejected: 0, retried: 0, blocked: 0,
};

function fakeRunner() {
  const calls = { count: 0 };
  return { _calls: calls, runOnce: async () => { calls.count += 1; return RESULT; } };
}

function fakeDiscoveryRunner() {
  const calls = { count: 0 };
  return { _calls: calls, runOnce: async () => { calls.count += 1; return DISCOVERY_RESULT; } };
}

function fakeRepo() {
  const calls = { prune: 0 };
  return { _calls: calls, pruneExpiredCaptures: async () => { calls.prune += 1; return 3; } };
}

describe('robinhood processing worker', () => {
  it('bounds its runtime options and honours the enabled flag', () => {
    const bounded = worker.__private.normalizeOptions({
      intervalMs: 5, pruneIntervalMs: 10, pruneLimit: 99_999,
    });
    assert.equal(bounded.intervalMs, 100); // clamped up to the floor
    assert.equal(bounded.pruneIntervalMs, 30_000); // clamped up to the floor
    assert.equal(bounded.pruneLimit, 50_000);
    assert.equal(bounded.runner.v4ContinuationRounds, 8);
    assert.equal(bounded.runner.v4ContinuationPoolLimit, 8);
    assert.equal(bounded.runner.v4SwapPrefixLimit, 512);
    assert.equal(worker.__private.normalizeOptions({
      v4ContinuationRounds: 999,
    }).runner.v4ContinuationRounds, 100);
    assert.equal(worker.__private.normalizeOptions({
      v4ContinuationPoolLimit: 999,
    }).runner.v4ContinuationPoolLimit, 64);
    assert.equal(worker.__private.normalizeOptions({
      v4SwapPrefixLimit: 9999,
    }).runner.v4SwapPrefixLimit, 2000);
    assert.equal(bounded.enabled, true);
    assert.equal(worker.__private.normalizeOptions({ enabled: false }).enabled, false);
  });

  // Runs first so the module-level prune clock is still at its initial zero.
  it('ticks both stream runners, aggregates counts into status, and prunes when due', async () => {
    const repository = fakeRepo();
    const discoveryRunner = fakeDiscoveryRunner();
    const normalized = worker.__private.normalizeOptions({});
    worker.__private.build(normalized, { runner: fakeRunner(), discoveryRunner, repository });

    const result = await worker.runOnce(normalized);

    // The loop stays hot on the combined claim count of both streams.
    assert.deepEqual(result, { ...RESULT, claimed: RESULT.claimed + DISCOVERY_RESULT.claimed });
    assert.equal(discoveryRunner._calls.count, 1);
    const status = worker.getStatus();
    assert.equal(status.lastProcessed, 3);
    assert.equal(status.totalProcessed, 3);
    assert.equal(status.lastV4ContinuationRounds, 2);
    assert.equal(status.lastV4ContinuationClaimed, 2);
    assert.equal(status.lastV4ContinuationPools, 1);
    assert.deepEqual(status.lastTiming, RESULT.timing);
    assert.equal(status.totalShadowCompared, 3);
    assert.equal(status.discovery.lastClaimed, 2);
    assert.equal(status.discovery.totalProcessed, 2);
    assert.equal(repository._calls.prune, 1);
    assert.equal(status.lastPrunedCaptures, 3);
  });

  it('does not prune again while still inside the retention window', async () => {
    const repository = fakeRepo();
    const normalized = worker.__private.normalizeOptions({ pruneIntervalMs: 3_600_000 });
    worker.__private.build(normalized, {
      runner: fakeRunner(), discoveryRunner: fakeDiscoveryRunner(), repository,
    });

    await worker.runOnce(normalized);

    assert.equal(repository._calls.prune, 0);
  });
});
