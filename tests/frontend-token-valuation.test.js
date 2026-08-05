const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

let resolveCoveredMetric;
let buildTokenChartViewportKey;
let fillTokenChartCandleGaps;
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
  ({
    buildTokenChartViewportKey,
    fillTokenChartCandleGaps,
    normalizeTokenChartCandle,
  } = await import('../frontend/src/utils/token-chart.ts'));
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

  it('interpolates connected internal chart gaps from 1m through 1h', () => {
    for (const granularityMinutes of [1, 5, 15, 30, 60]) {
      const bucketMs = granularityMinutes * 60_000;
      const result = fillTokenChartCandleGaps([
        {
          bucketTs: '2026-08-05T00:00:00.000Z',
          open: 90, high: 110, low: 80, close: 100,
        },
        {
          bucketTs: new Date(Date.parse('2026-08-05T00:00:00.000Z') + 3 * bucketMs).toISOString(),
          open: 120, high: 130, low: 115, close: 125,
        },
      ], granularityMinutes);

      assert.equal(result.length, 4);
      assert.deepEqual(result[1], {
        bucketTs: new Date(Date.parse('2026-08-05T00:00:00.000Z') + bucketMs).toISOString(),
        open: 100, high: 110, low: 100, close: 110,
      });
      assert.deepEqual(result[2], {
        bucketTs: new Date(Date.parse('2026-08-05T00:00:00.000Z') + (2 * bucketMs)).toISOString(),
        open: 110, high: 120, low: 110, close: 120,
      });
      assert.equal(result[2].close, result[3].open);
    }

    const falling = fillTokenChartCandleGaps([
      { bucketTs: '2026-08-05T00:00:00.000Z', open: 110, high: 115, low: 95, close: 100 },
      { bucketTs: '2026-08-05T00:02:00.000Z', open: 80, high: 85, low: 75, close: 82 },
    ], 1);
    assert.deepEqual(falling[1], {
      bucketTs: '2026-08-05T00:01:00.000Z',
      open: 100, high: 100, low: 80, close: 80,
    });
  });

  it('preserves an independent expanded-chart viewport for each timeframe', () => {
    const identityKey = 'robinhood:0xabc';

    assert.equal(buildTokenChartViewportKey(identityKey, 1), 'robinhood:0xabc::1');
    assert.equal(buildTokenChartViewportKey(identityKey, 5), 'robinhood:0xabc::5');
    assert.notEqual(
      buildTokenChartViewportKey(identityKey, 1),
      buildTokenChartViewportKey(identityKey, 5),
    );
  });

  it('does not fill gaps in 4h and 24h charts', () => {
    const candles = [
      { bucketTs: '2026-08-05T00:00:00.000Z', open: 90, high: 110, low: 80, close: 100 },
      { bucketTs: '2026-08-05T08:00:00.000Z', open: 120, high: 130, low: 115, close: 125 },
    ];

    assert.deepEqual(fillTokenChartCandleGaps(candles, 240), candles);
    assert.deepEqual(fillTokenChartCandleGaps(candles, 1440), candles);
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
