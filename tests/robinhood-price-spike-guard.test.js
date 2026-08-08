'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replayMarket } = require('../src/services/robinhood-price-spike-guard');

const K = { maxMultiple: 8, recoverAfter: 3 };
const verdicts = (prices, opts = K) => replayMarket(prices.map((priceUsd) => ({ priceUsd })), opts).map((v) => v.spike);

test('first observation is always kept (no reference to compare)', () => {
  assert.deepEqual(verdicts([0.1]), [false]);
});

test('gradual moves within the band are all kept, even to a far level', () => {
  // 0.1 -> 0.5 -> 2 -> 10 -> 50: each step <= 8x the last, so all real.
  assert.deepEqual(verdicts([0.1, 0.5, 2, 10, 50]), [false, false, false, false, false]);
});

test('an isolated spike is rejected and does not become the reference', () => {
  // normal 0.1, spike to 3.4e50, back to 0.11 -> only the spike is dropped.
  assert.deepEqual(verdicts([0.1, 3.4e50, 0.11]), [false, true, false]);
});

test('a downward isolated spike is rejected too', () => {
  assert.deepEqual(verdicts([100, 0.0001, 110]), [false, true, false]);
});

test('a sustained jump recovers after recoverAfter consecutive rejects', () => {
  // jump to 1000 and stay: first (recoverAfter-1)=2 are rejected, the 3rd re-anchors,
  // and everything after the new level is kept.
  assert.deepEqual(
    verdicts([1, 1000, 1000, 1000, 1000, 1000]),
    [false, true, true, false, false, false]
  );
});

test('K controls sensitivity: an 8x spike is caught at K=5 but not at K=10', () => {
  assert.deepEqual(verdicts([5, 40, 5.1], { maxMultiple: 5, recoverAfter: 3 }), [false, true, false]);
  assert.deepEqual(verdicts([5, 40, 5.1], { maxMultiple: 10, recoverAfter: 3 }), [false, false, false]);
});

test('absolute ceiling rejects unconditionally — even the first value and under recovery', () => {
  const opts = { maxMultiple: 8, recoverAfter: 3, ceiling: 1e10 };
  // first value already above the ceiling -> rejected, never anchors the reference
  assert.deepEqual(verdicts([1e12], opts), [true]);
  // a burst that would recover under the relative rule stays rejected by the ceiling
  assert.deepEqual(verdicts([1, 1e12, 1e12, 1e12, 1e12], opts), [false, true, true, true, true]);
});
