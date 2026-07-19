const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let getWorkspaceSparklineNextRefreshAt;
let resolveWorkspaceSparklineGranularityMinutes;
let runWorkspaceSparklineRequestWithTimeout;
let selectWorkspaceSparklineRefreshBatches;
let splitWorkspaceSparklineBatchesByChain;

before(async () => {
  ({
    getWorkspaceSparklineNextRefreshAt,
    resolveWorkspaceSparklineGranularityMinutes,
    runWorkspaceSparklineRequestWithTimeout,
    selectWorkspaceSparklineRefreshBatches,
    splitWorkspaceSparklineBatchesByChain,
  } = await import('../frontend/src/state/workspace-sparkline-refresh.ts'));
});

describe('workspace sparkline request shape', () => {
  it('fits full range resolutions inside the 336 point budget', () => {
    const cases = [
      [1, 5],
      [3, 15],
      [7, 30],
      [14, 60],
    ];
    for (const [rangeDays, expected] of cases) {
      assert.equal(resolveWorkspaceSparklineGranularityMinutes({
        rangeDays,
        points: 336,
        referenceTs: Date.UTC(2026, 6, 18),
      }), expected);
    }
  });

  it('keeps one-minute resolution when the token age fits the point budget', () => {
    const referenceTs = Date.UTC(2026, 6, 18, 12);
    assert.equal(resolveWorkspaceSparklineGranularityMinutes({
      anchorAt: referenceTs - (3 * 60 * 60 * 1000),
      rangeDays: 14,
      points: 336,
      referenceTs,
    }), 1);
  });

  it('uses the selected-range resolution once a token is older than one day', () => {
    const referenceTs = Date.UTC(2026, 6, 18, 12);
    assert.equal(resolveWorkspaceSparklineGranularityMinutes({
      anchorAt: referenceTs - (5 * 24 * 60 * 60 * 1000),
      rangeDays: 14,
      points: 336,
      referenceTs,
    }), 60);
  });

  it('isolates same-shape batches by chain', () => {
    const solana = { chain: 'solana', address: 'sol', key: 'solana:sol' };
    const robinhood = { chain: 'robinhood', address: '0x1', key: 'robinhood:0x1' };
    assert.deepEqual(splitWorkspaceSparklineBatchesByChain([{
      hours: 336,
      granularityMinutes: 60,
      identities: [solana, robinhood],
    }]), [
      { hours: 336, granularityMinutes: 60, identities: [solana] },
      { hours: 336, granularityMinutes: 60, identities: [robinhood] },
    ]);
  });

  it('aborts a request that exceeds its time budget', async () => {
    let observedAbort = false;
    await assert.rejects(runWorkspaceSparklineRequestWithTimeout(5, (signal) => (
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('aborted'));
        }, { once: true });
      })
    )), /timed out after 5ms/);
    assert.equal(observedAbort, true);
  });
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

  it('keeps same-address identities isolated by chain cache key', () => {
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    const address = '0xabcdef0123456789abcdef0123456789abcdef01';
    const base = { chain: 'base', address, key: `base:${address}` };
    const robinhood = { chain: 'robinhood', address, key: `robinhood:${address}` };
    const batches = [{
      hours: 24,
      granularityMinutes: 30,
      identities: [base, robinhood],
    }];
    const cache = {
      [base.key]: {
        hours: 24,
        granularityMinutes: 30,
        refreshedAt: now - 1_000,
      },
    };

    assert.deepEqual(selectWorkspaceSparklineRefreshBatches(batches, cache, {
      now,
      refreshIntervalMs: 60_000,
    }), [{
      hours: 24,
      granularityMinutes: 30,
      identities: [robinhood],
    }]);
    assert.equal(getWorkspaceSparklineNextRefreshAt(batches, cache, 60_000), 0);
  });
});
