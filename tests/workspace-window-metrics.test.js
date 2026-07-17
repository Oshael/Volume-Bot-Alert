const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DEFAULT_BASELINE_TOLERANCE_MS,
  WINDOW_MS,
  buildNormalizedWindowMetrics,
  calculatePriceChange,
  normalizeAsOf,
  resolveBaselineCoverage,
  resolveContinuousCoverage,
  resolveSnapshotCoverage,
} = require('../src/services/workspace-window-metrics');

const AS_OF = '2026-07-15T18:00:47.900Z';
const WINDOW_END = '2026-07-15T18:00:00.000Z';

describe('workspace window metric contract', () => {
  it('uses one minute-aligned asOf boundary', () => {
    assert.equal(normalizeAsOf(AS_OF).toISOString(), WINDOW_END);
    assert.equal(normalizeAsOf(WINDOW_END).toISOString(), WINDOW_END);
    assert.throws(() => normalizeAsOf('invalid'), /asOf is invalid/);
  });

  it('classifies continuous ingestion coverage without treating gaps as zero', () => {
    const cases = [
      {
        name: 'full hour',
        input: {
          window: '1h', windowEnd: WINDOW_END,
          coverageStartAt: '2026-07-15T16:00:00.000Z',
          coverageEndAt: WINDOW_END,
        },
        expected: 'complete',
      },
      {
        name: 'bootstrap inside window',
        input: {
          window: '1h', windowEnd: WINDOW_END,
          coverageStartAt: '2026-07-15T17:30:00.000Z',
          coverageEndAt: WINDOW_END,
        },
        expected: 'partial',
      },
      {
        name: 'cursor behind window end',
        input: {
          window: '5m', windowEnd: WINDOW_END,
          coverageStartAt: '2026-07-15T12:00:00.000Z',
          coverageEndAt: '2026-07-15T17:58:00.000Z',
        },
        expected: 'partial',
      },
      {
        name: 'no cursor evidence',
        input: { window: '24h', windowEnd: WINDOW_END },
        expected: 'unavailable',
      },
      {
        name: 'coverage outside requested window',
        input: {
          window: '5m', windowEnd: WINDOW_END,
          coverageStartAt: '2026-07-15T16:00:00.000Z',
          coverageEndAt: '2026-07-15T17:00:00.000Z',
        },
        expected: 'unavailable',
      },
    ];

    for (const testCase of cases) {
      assert.equal(
        resolveContinuousCoverage(testCase.input), testCase.expected, testCase.name,
      );
    }
  });

  it('requires upstream snapshots to align with the requested window end', () => {
    assert.equal(resolveSnapshotCoverage({
      window: '24h', windowEnd: WINDOW_END, value: 0,
      observedAt: '2026-07-15T17:59:00.000Z',
    }), 'complete');

    assert.equal(resolveSnapshotCoverage({
      window: '1h', windowEnd: WINDOW_END, value: 500,
      observedAt: '2026-07-15T17:40:00.000Z',
    }), 'partial');

    assert.equal(resolveSnapshotCoverage({
      window: '5m', windowEnd: WINDOW_END, value: 0,
      observedAt: '2026-07-15T17:46:00.000Z',
    }), 'partial');

    assert.equal(resolveSnapshotCoverage({
      window: '1h', windowEnd: WINDOW_END, value: 500,
      observedAt: '2026-07-15T17:59:00.000Z',
      requiresWindowHistory: true,
      historyStartAt: '2026-07-15T17:30:00.000Z',
    }), 'partial');

    assert.equal(resolveSnapshotCoverage({
      window: '1h', windowEnd: WINDOW_END, value: 500,
      observedAt: '2026-07-15T17:59:00.000Z',
      requiresWindowHistory: true,
      historyStartAt: '2026-07-15T16:30:00.000Z',
    }), 'complete');

    assert.equal(resolveSnapshotCoverage({
      window: '5m', windowEnd: WINDOW_END, value: null,
      observedAt: '2026-07-15T17:59:00.000Z',
    }), 'unavailable');
  });

  it('returns zero only for a complete window with no activity', () => {
    const result = buildNormalizedWindowMetrics({
      asOf: AS_OF,
      lastActivityAt: '2026-07-15T17:20:00.000Z',
      volumes: { '5m': null, '1h': '125000', '6h': null, '24h': null },
      swaps: { '5m': null, '1h': '18' },
      coverage: {
        '5m': 'complete', '1h': 'complete', '6h': 'partial', '24h': 'unavailable',
      },
      swapCoverage: {
        '5m': 'complete', '1h': 'complete', '6h': 'unavailable', '24h': 'unavailable',
      },
    });

    assert.equal(result.windowEnd, WINDOW_END);
    assert.equal(result.lastActivityAt, '2026-07-15T17:20:00.000Z');
    assert.equal(result.volume5mUsd, 0);
    assert.equal(result.volume1hUsd, 125000);
    assert.equal(result.volume6hUsd, null);
    assert.equal(result.volume24hUsd, null);
    assert.equal(result.swaps5m, 0);
    assert.equal(result.swaps1h, 18);
    assert.equal(result.swaps6h, null);
    assert.deepEqual(result.coverage, {
      '5m': 'complete', '1h': 'complete', '6h': 'partial', '24h': 'unavailable',
    });
  });

  it('keeps price change null until current and baseline observations are trustworthy', () => {
    const complete = resolveBaselineCoverage({
      window: '1h', windowEnd: WINDOW_END,
      currentObservedAt: '2026-07-15T17:59:00.000Z',
      baselineObservedAt: '2026-07-15T16:58:00.000Z',
    });
    const partial = resolveBaselineCoverage({
      window: '1h', windowEnd: WINDOW_END,
      currentObservedAt: '2026-07-15T17:59:00.000Z',
      baselineObservedAt: new Date(
        Date.parse('2026-07-15T17:00:00.000Z') - DEFAULT_BASELINE_TOLERANCE_MS - 1,
      ),
    });
    assert.equal(complete, 'complete');
    assert.equal(partial, 'partial');
    assert.equal(resolveBaselineCoverage({
      window: '6h', windowEnd: WINDOW_END,
      currentObservedAt: '2026-07-15T17:59:00.000Z',
      baselineObservedAt: null,
    }), 'unavailable');
    assert.equal(calculatePriceChange('2', '1.6'), 25);
    assert.equal(calculatePriceChange('2', null), null);

    const result = buildNormalizedWindowMetrics({
      windowEnd: WINDOW_END,
      priceChanges: { '1h': 25, '6h': 50, '24h': 100 },
      priceChangeCoverage: {
        '1h': complete, '6h': partial, '24h': 'unavailable',
      },
    });
    assert.equal(result.priceChange1hPct, 25);
    assert.equal(result.priceChange6hPct, null);
    assert.equal(result.priceChange24hPct, null);
  });

  it('rejects unsupported windows and malformed metric values', () => {
    assert.equal(WINDOW_MS['24h'], 24 * 60 * 60 * 1000);
    assert.throws(
      () => resolveContinuousCoverage({ window: '4h', windowEnd: WINDOW_END }),
      /Unsupported/,
    );
    assert.throws(() => buildNormalizedWindowMetrics({
      windowEnd: WINDOW_END,
      volumes: { '5m': -1 },
      coverage: { '5m': 'complete' },
    }), /5m volume is invalid/);
    assert.throws(() => buildNormalizedWindowMetrics({
      windowEnd: WINDOW_END,
      swaps: { '1h': 1.5 },
      swapCoverage: { '1h': 'partial' },
    }), /safe integer range/);
    assert.throws(() => buildNormalizedWindowMetrics({
      windowEnd: WINDOW_END,
      lastActivityAt: '2026-07-15T18:01:00.000Z',
    }), /cannot be after/);
  });
});
