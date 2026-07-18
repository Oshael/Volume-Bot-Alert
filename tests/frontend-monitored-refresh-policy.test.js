const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

let policy;

before(async () => {
  policy = await import('../frontend/src/state/monitored-refresh-policy.ts');
});

describe('frontend monitored refresh policy', () => {
  it('applies the fresh first page without discarding tokens still loading', () => {
    const existing = [
      { chain: 'robinhood', address: '0x01', fdv: 100 },
      { chain: 'robinhood', address: '0x02', fdv: 200 },
    ];
    const incoming = [
      { chain: 'robinhood', address: '0x01', fdv: 150 },
      { chain: 'robinhood', address: '0x03', fdv: 300 },
    ];

    assert.deepEqual(policy.mergeMonitoredFirstPage(existing, incoming), [
      incoming[0], incoming[1], existing[1],
    ]);

    const caseSensitive = policy.mergeMonitoredFirstPage(
      [{ chain: 'solana', address: 'AbC' }],
      [{ chain: 'solana', address: 'abc' }],
    );
    assert.equal(caseSensitive.length, 2);
  });

  it('runs full hydration for an empty snapshot or only after the cold deadline', () => {
    assert.equal(policy.shouldRunFullMonitoredHydration(false, 60_000, 1_000), true);
    assert.equal(policy.shouldRunFullMonitoredHydration(true, 60_000, 59_999), false);
    assert.equal(policy.shouldRunFullMonitoredHydration(true, 60_000, 60_000), true);
  });

  it('keeps realtime valuation authoritative over an older REST snapshot', () => {
    const liveObservedAt = '2026-07-18T23:00:45.000Z';
    assert.equal(policy.shouldApplyDashboardValuation(liveObservedAt, {
      windowEnd: '2026-07-18T23:01:00.000Z',
      valuation: { observedAt: '2026-07-18T22:59:58.000Z' },
    }), false);
    assert.equal(policy.shouldApplyDashboardValuation(liveObservedAt, {
      valuation: { observedAt: '2026-07-18T23:00:46.000Z' },
    }), true);
    assert.equal(policy.shouldApplyDashboardValuation(null, {
      valuation: { observedAt: '2026-07-18T22:59:58.000Z' },
    }), true);
  });
});
