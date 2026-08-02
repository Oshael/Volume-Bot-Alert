const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let getWorkspaceSparklineNextRefreshAt;
let mergeWorkspaceSparklineRefreshEntry;
let mergeWorkspaceSparklineSnapshotEntry;
let resolveWorkspaceSparklineGranularityMinutes;
let resolveWorkspaceSparklineRequestShape;
let runWorkspaceSparklineRequestWithTimeout;
let selectWorkspaceSparklineRefreshBatches;
let splitWorkspaceSparklineBatchesByChain;

before(async () => {
  ({
    getWorkspaceSparklineNextRefreshAt,
    mergeWorkspaceSparklineRefreshEntry,
    mergeWorkspaceSparklineSnapshotEntry,
    resolveWorkspaceSparklineGranularityMinutes,
    resolveWorkspaceSparklineRequestShape,
    runWorkspaceSparklineRequestWithTimeout,
    selectWorkspaceSparklineRefreshBatches,
    splitWorkspaceSparklineBatchesByChain,
  } = await import('../frontend/src/state/workspace-sparkline-refresh.ts'));
});

describe('workspace sparkline request shape', () => {
  it('uses the canonical Solana resolution tier for every selectable range', () => {
    const cases = [
      [1, 1],
      [2, 5],
      [3, 5],
      [4, 15],
      [5, 15],
      [6, 15],
      [7, 15],
      [8, 15],
      [9, 15],
      [10, 15],
      [11, 15],
      [12, 30],
      [13, 30],
      [14, 30],
    ];
    for (const [rangeDays, expected] of cases) {
      assert.equal(resolveWorkspaceSparklineGranularityMinutes({
        rangeDays,
        referenceTs: Date.UTC(2026, 6, 18),
      }), expected);
    }
  });

  it('keeps one-minute resolution when the effective token lifespan is under one day', () => {
    const referenceTs = Date.UTC(2026, 6, 18, 12);
    assert.equal(resolveWorkspaceSparklineGranularityMinutes({
      anchorAt: referenceTs - (3 * 60 * 60 * 1000),
      rangeDays: 14,
      referenceTs,
    }), 1);
  });

  it('uses 15m for a five-day token inside the 14-day view', () => {
    const referenceTs = Date.UTC(2026, 6, 18, 12);
    assert.equal(resolveWorkspaceSparklineGranularityMinutes({
      anchorAt: referenceTs - (5 * 24 * 60 * 60 * 1000),
      rangeDays: 14,
      referenceTs,
    }), 15);
  });

  it('keeps a 14-day preset at one-minute resolution for a three-hour token', () => {
    const referenceTs = Date.UTC(2026, 6, 18, 12);
    assert.deepEqual(resolveWorkspaceSparklineRequestShape({
      anchorAt: referenceTs - (3 * 60 * 60 * 1000),
      requestedHours: 14 * 24,
      referenceTs,
    }), {
      hours: 14 * 24,
      granularityMinutes: 1,
      allAvailable: false,
      queryAllAvailable: false,
    });
  });

  it('loads all of a young token with its age-adapted timed resolution', () => {
    const referenceTs = Date.UTC(2026, 6, 18, 12);
    assert.deepEqual(resolveWorkspaceSparklineRequestShape({
      anchorAt: referenceTs - (5 * 24 * 60 * 60 * 1000),
      requestedHours: 14 * 24,
      allAvailable: true,
      referenceTs,
    }), {
      hours: 5 * 24,
      granularityMinutes: 15,
      allAvailable: true,
      queryAllAvailable: false,
    });
  });

  it('keeps the full-history hourly query for old or unknown token ages', () => {
    const referenceTs = Date.UTC(2026, 6, 18, 12);
    for (const anchorAt of [null, referenceTs - (31 * 24 * 60 * 60 * 1000)]) {
      assert.deepEqual(resolveWorkspaceSparklineRequestShape({
        anchorAt,
        requestedHours: 14 * 24,
        allAvailable: true,
        referenceTs,
      }), {
        hours: 0,
        granularityMinutes: 60,
        allAvailable: true,
        queryAllAvailable: true,
      });
    }
  });

  it('isolates same-shape batches by chain', () => {
    const solana = { chain: 'solana', address: 'sol', key: 'solana:sol' };
    const robinhood = { chain: 'robinhood', address: '0x1', key: 'robinhood:0x1' };
    assert.deepEqual(splitWorkspaceSparklineBatchesByChain([{
      hours: 336,
      granularityMinutes: 30,
      identities: [solana, robinhood],
    }]), [
      { hours: 336, granularityMinutes: 30, identities: [solana] },
      { hours: 336, granularityMinutes: 30, identities: [robinhood] },
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
  it('preserves a renderable series when a same-shape refresh is temporarily empty', () => {
    const previous = {
      address: '0x1',
      hours: 24,
      granularityMinutes: 1,
      refreshedAt: 100,
      generatedAt: '2026-08-02T12:00:00.000Z',
      series: [10, 12, 11],
      candles: [{ bucketTs: '2026-08-02T12:00:00.000Z' }],
    };
    const incoming = {
      address: '0x1',
      hours: 24,
      granularityMinutes: 1,
      refreshedAt: 200,
      series: [],
      loading: false,
    };

    assert.deepEqual(mergeWorkspaceSparklineRefreshEntry(previous, incoming), {
      ...previous,
      refreshedAt: 200,
      loading: false,
    });
  });

  it('does not preserve an incompatible series after the request shape changes', () => {
    const incoming = {
      address: '0x1',
      hours: 1,
      granularityMinutes: 1,
      refreshedAt: 200,
      series: [],
      loading: false,
    };

    assert.equal(mergeWorkspaceSparklineRefreshEntry({
      address: '0x1',
      hours: 24,
      granularityMinutes: 1,
      refreshedAt: 100,
      series: [10, 12],
    }, incoming), incoming);
  });

  it('keeps a newer realtime candle when an older HTTP snapshot finishes later', () => {
    const previous = {
      address: '0x1',
      valuationType: 'fdv',
      hours: 24,
      granularityMinutes: 1,
      points: 3,
      generatedAt: '2026-08-02T12:01:10.000Z',
      refreshedAt: 100,
      series: [100, 120],
      candles: [
        { bucketTs: '2026-08-02T12:00:00.000Z', closeFdvUsd: 100 },
        {
          bucketTs: '2026-08-02T12:01:00.000Z',
          closeFdvUsd: 120,
          liveSequence: 'robinhood:2:1:1',
        },
      ],
    };
    const incoming = {
      address: '0x1',
      valuationType: 'fdv',
      hours: 24,
      granularityMinutes: 1,
      points: 3,
      generatedAt: '2026-08-02T12:01:00.000Z',
      refreshedAt: 200,
      series: [90, 105],
      candles: [
        { bucketTs: '2026-08-02T11:59:00.000Z', closeFdvUsd: 90 },
        { bucketTs: '2026-08-02T12:00:00.000Z', closeFdvUsd: 105 },
      ],
      loading: false,
    };

    assert.deepEqual(mergeWorkspaceSparklineSnapshotEntry(previous, incoming), {
      ...incoming,
      generatedAt: previous.generatedAt,
      latestBucketAt: '2026-08-02T12:01:00.000Z',
      bucketCount: 3,
      series: [90, 105, 120],
      candles: [incoming.candles[0], incoming.candles[1], previous.candles[1]],
      loading: false,
    });
  });

  it('accepts a newer HTTP snapshot without retaining an older realtime candle', () => {
    const incoming = {
      address: '0x1',
      valuationType: 'fdv',
      hours: 24,
      granularityMinutes: 1,
      generatedAt: '2026-08-02T12:02:00.000Z',
      series: [100, 130],
      candles: [
        { bucketTs: '2026-08-02T12:00:00.000Z', closeFdvUsd: 100 },
        { bucketTs: '2026-08-02T12:01:00.000Z', closeFdvUsd: 130 },
      ],
    };

    assert.equal(mergeWorkspaceSparklineSnapshotEntry({
      ...incoming,
      generatedAt: '2026-08-02T12:01:10.000Z',
      series: [100, 120],
      candles: [{
        bucketTs: '2026-08-02T12:01:00.000Z',
        closeFdvUsd: 120,
        liveSequence: 'robinhood:2:1:1',
      }],
    }, incoming), incoming);
  });

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

  it('refreshes when the same timed shape changes between a preset and all', () => {
    const now = Date.UTC(2026, 6, 8, 20, 30, 0);
    const batches = [{
      hours: 120,
      granularityMinutes: 15,
      allAvailable: true,
      addresses: ['young-token'],
    }];
    const cache = {
      'young-token': {
        hours: 120,
        granularityMinutes: 15,
        allAvailable: false,
        refreshedAt: now - 5_000,
      },
    };

    assert.deepEqual(selectWorkspaceSparklineRefreshBatches(batches, cache, {
      now,
      refreshIntervalMs: 60_000,
    }), batches);
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
