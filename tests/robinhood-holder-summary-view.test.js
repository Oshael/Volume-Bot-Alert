const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  HOLDER_FRESHNESS_TARGET_MS,
  buildDailyHolderHistory,
  normalizeRobinhoodHolderSummary,
} = require('../src/utils/robinhood-holder-summary-view');

describe('Robinhood holder summary view', () => {
  it('normalizes a fresh persisted count without losing integer precision', () => {
    const asOf = new Date('2026-08-10T12:00:00.000Z');
    const summary = normalizeRobinhoodHolderSummary({
      holder_count: '4424',
      holder_observed_at: new Date(asOf.getTime() - HOLDER_FRESHNESS_TARGET_MS),
      holder_checked_at: asOf,
    }, asOf);

    assert.deepEqual(summary, {
      holderCount: 4424,
      holderObservedAt: '2026-08-10T11:45:00.000Z',
      holderCheckedAt: '2026-08-10T12:00:00.000Z',
      holderFreshness: 'fresh',
    });
  });

  it('marks old and missing observations explicitly', () => {
    const stale = normalizeRobinhoodHolderSummary({
      holder_count: 10,
      holder_observed_at: '2026-08-10T11:44:59.999Z',
      holder_checked_at: '2026-08-10T12:00:00.000Z',
    }, '2026-08-10T12:00:00.000Z');
    const missing = normalizeRobinhoodHolderSummary({}, '2026-08-10T12:00:00.000Z');

    assert.equal(stale.holderFreshness, 'stale');
    assert.equal(missing.holderCount, null);
    assert.equal(missing.holderFreshness, 'unavailable');
  });

  it('uses live cursor progress instead of the last count change for ledger freshness', () => {
    const live = normalizeRobinhoodHolderSummary({
      holder_count: 4424,
      holder_source: 'ledger_live',
      holder_observed_at: '2026-08-10T10:00:00.000Z',
      holder_checked_at: '2026-08-10T11:59:59.000Z',
    }, '2026-08-10T12:00:00.000Z');

    assert.equal(live.holderFreshness, 'fresh');
  });

  it('rejects unsafe persisted counts', () => {
    assert.throws(() => normalizeRobinhoodHolderSummary({
      holder_count: '9007199254740992',
    }), /safe integer/);
  });

  it('builds daily sticks with total holders and signed 24h deltas', () => {
    const history = buildDailyHolderHistory([
      { date: '2026-08-07', holderCount: 100, observedAt: '2026-08-07T23:00:00.000Z' },
      { date: '2026-08-08', holderCount: 120, observedAt: '2026-08-08T23:00:00.000Z' },
      { date: '2026-08-09', holderCount: 90, observedAt: '2026-08-09T23:00:00.000Z' },
    ], 2);

    assert.deepEqual(history.baseline, {
      date: '2026-08-07', holderCount: 100, observedAt: '2026-08-07T23:00:00.000Z',
    });
    assert.deepEqual(history.points.map(({ date, holderCount, delta24h, delta24hPct }) => ({
      date, holderCount, delta24h, delta24hPct,
    })), [
      { date: '2026-08-08', holderCount: 120, delta24h: 20, delta24hPct: 20 },
      { date: '2026-08-09', holderCount: 90, delta24h: -30, delta24hPct: -25 },
    ]);
  });

  it('marks a missing calendar day instead of inventing a 24h comparison', () => {
    const history = buildDailyHolderHistory([
      { date: '2026-08-07', holderCount: 100, observedAt: '2026-08-07T23:00:00.000Z' },
      { date: '2026-08-09', holderCount: 130, observedAt: '2026-08-09T23:00:00.000Z' },
    ], 2);

    assert.equal(history.points[0].comparison, 'unavailable');
    assert.equal(history.points[0].delta24h, null);
    assert.equal(history.points[0].delta24hPct, null);
  });
});
