const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

let resolveCoveredMetric;
let normalizeTokenChartCandle;
let resolveTokenValuation;
let resolveWorkspaceMarketSnapshotMs;
let selectWorkspaceSnapshotValue;

before(async () => {
  ({
    resolveCoveredMetric,
    resolveTokenValuation,
    resolveWorkspaceMarketSnapshotMs,
    selectWorkspaceSnapshotValue,
  } = await import('../frontend/src/utils/token-valuation.ts'));
  ({ normalizeTokenChartCandle } = await import('../frontend/src/utils/token-chart.ts'));
});

describe('frontend token valuation presentation', () => {
  it('keeps real market cap authoritative when both valuations exist', () => {
    assert.deepEqual(
      resolveTokenValuation({ mcap: 125_000, fdv: 500_000, valuationType: 'fdv' }),
      {
        label: 'MCAP', value: 125_000, type: 'market-cap',
        observedAt: null, freshness: 'unknown',
      },
    );
  });

  it('labels FDV honestly when circulating market cap is unavailable', () => {
    assert.deepEqual(
      resolveTokenValuation({
        mcap: null,
        fdv: 500_000,
        valuationType: 'fdv',
        valuation: {
          type: 'fdv',
          usd: 500_000,
          observedAt: '2026-07-15T18:00:00.000Z',
          freshness: 'stale',
        },
      }),
      {
        label: 'FDV', value: 500_000, type: 'fdv',
        observedAt: '2026-07-15T18:00:00.000Z', freshness: 'stale',
      },
    );
  });

  it('does not manufacture a valuation when neither metric exists', () => {
    assert.deepEqual(
      resolveTokenValuation({ mcap: null, fdv: null, valuationType: 'fdv' }),
      {
        label: 'FDV', value: null, type: null,
        observedAt: null, freshness: 'unknown',
      },
    );
  });

  it('does not manufacture a zero FDV candle from a null observation', () => {
    assert.equal(normalizeTokenChartCandle({
      bucketTs: '2026-07-15T18:00:00.000Z',
      valuationType: 'fdv',
      closeFdvUsd: null,
    }, 'fdv'), null);
  });

  it('does not attach freshness from a mismatched valuation type', () => {
    const result = resolveTokenValuation({
      mcap: 125_000,
      valuation: {
        type: 'fdv', usd: 125_000, observedAt: '2026-07-15T18:00:00.000Z', freshness: 'fresh',
      },
    });

    assert.equal(result.type, 'market-cap');
    assert.equal(result.freshness, 'unknown');
    assert.equal(result.observedAt, null);
  });

  it('does not attach freshness from another observation of the same valuation type', () => {
    const result = resolveTokenValuation({
      fdv: 125_000,
      valuation: {
        type: 'fdv', usd: 500_000, observedAt: '2026-07-15T18:00:00.000Z', freshness: 'fresh',
      },
    });

    assert.equal(result.type, 'fdv');
    assert.equal(result.freshness, 'unknown');
    assert.equal(result.observedAt, null);
  });

  it('keeps complete zero distinct from unavailable or partial metrics', () => {
    assert.deepEqual(resolveCoveredMetric(0, 'complete'), {
      value: 0, coverage: 'complete', available: true, isZero: true, isPartial: false,
    });
    assert.deepEqual(resolveCoveredMetric(0, 'unavailable'), {
      value: null, coverage: 'unavailable', available: false, isZero: false, isPartial: false,
    });
    assert.deepEqual(resolveCoveredMetric(125, 'partial'), {
      value: 125, coverage: 'partial', available: true, isZero: false, isPartial: true,
    });
  });

  it('orders workspace snapshots by window and observation timestamps', () => {
    assert.equal(resolveWorkspaceMarketSnapshotMs({
      windowEnd: '2026-07-15T18:00:00.000Z',
      lastSeenAt: '2026-07-15T18:05:00.000Z',
      valuation: { observedAt: '2026-07-15T17:59:00.000Z' },
    }), Date.parse('2026-07-15T18:00:00.000Z'));
    assert.equal(resolveWorkspaceMarketSnapshotMs({ windowEnd: 'invalid' }), null);
  });

  it('clears unavailable values only when the incoming snapshot is authoritative', () => {
    assert.equal(selectWorkspaceSnapshotValue(true, null, 500, 400), null);
    assert.equal(selectWorkspaceSnapshotValue(false, null, 500, 400), 500);
  });
});
