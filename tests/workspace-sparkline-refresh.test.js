const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let getWorkspaceSparklineNextRefreshAt;
let selectWorkspaceSparklineRefreshBatches;

before(async () => {
  ({
    getWorkspaceSparklineNextRefreshAt,
    selectWorkspaceSparklineRefreshBatches,
  } = await import('../frontend/src/state/workspace-sparkline-refresh.ts'));
});

describe('workspace sparkline refresh selection', () => {
  it('refreshes only the new address when the visible list changes inside the cache window', () => {
    const now = Date.UTC(2026, 6, 8, 20, 29, 13);
    const refreshIntervalMs = 60_000;
    const existingAddresses = Array.from({ length: 46 }, (_, index) => `token-${index}`);
    const cache = Object.fromEntries(existingAddresses.map((address) => [address, {
      address,
      hours: 336,
      granularityMinutes: 5,
      refreshedAt: now - 14_000,
      series: [1, 2],
    }]));
    const batches = [{
      hours: 336,
      granularityMinutes: 5,
      addresses: [...existingAddresses, 'new-token'],
    }];

    const selected = selectWorkspaceSparklineRefreshBatches(batches, cache, {
      now,
      refreshIntervalMs,
    });

    assert.deepEqual(selected, [{
      hours: 336,
      granularityMinutes: 5,
      addresses: ['new-token'],
    }]);
  });

  it('refreshes only entries whose request shape changed or expired', () => {
    const now = Date.UTC(2026, 6, 8, 20, 30, 0);
    const refreshIntervalMs = 60_000;
    const batches = [{
      hours: 336,
      granularityMinutes: 5,
      addresses: ['fresh', 'granularity-changed', 'expired'],
    }];
    const cache = {
      fresh: { hours: 336, granularityMinutes: 5, refreshedAt: now - 5_000 },
      'granularity-changed': { hours: 336, granularityMinutes: 1, refreshedAt: now - 5_000 },
      expired: { hours: 336, granularityMinutes: 5, refreshedAt: now - 60_000 },
    };

    const selected = selectWorkspaceSparklineRefreshBatches(batches, cache, {
      now,
      refreshIntervalMs,
    });

    assert.deepEqual(selected[0].addresses, ['granularity-changed', 'expired']);
    assert.equal(
      getWorkspaceSparklineNextRefreshAt(batches, cache, refreshIntervalMs),
      0,
    );
  });

  it('treats a fresh empty-result cache entry as fetched', () => {
    const now = Date.UTC(2026, 6, 8, 20, 30, 0);
    const batches = [{ hours: 24, granularityMinutes: 1, addresses: ['empty-token'] }];
    const cache = {
      'empty-token': {
        hours: 24,
        granularityMinutes: 1,
        refreshedAt: now - 1_000,
      },
    };

    assert.deepEqual(selectWorkspaceSparklineRefreshBatches(batches, cache, {
      now,
      refreshIntervalMs: 60_000,
    }), []);
  });
});
