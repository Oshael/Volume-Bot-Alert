'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { replayMarket, evaluateFdvBand } = require('../src/services/robinhood-price-spike-guard');

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

describe('evaluateFdvBand (live dead-pool guard)', () => {
  const band = (fdvUsd, reference, maxMultiple = 5) => (
    evaluateFdvBand({ fdvUsd, reference, maxMultiple }).outlier
  );

  test('keeps fdv inside the band [ref/k, ref*k]', () => {
    assert.equal(band(94e6, 94e6), false); // at the reference
    assert.equal(band(200e6, 94e6), false); // ~2.1x, within 5x
    assert.equal(band(40e6, 94e6), false); // real dip, within ref/5
  });

  test('rejects an upward outlier above ref*k', () => {
    assert.equal(band(8e12, 94e6), true); // catastrophic
    assert.equal(band(600e6, 94e6), true); // >5x
  });

  test('rejects a downward outlier below ref/k — the $90M -> $8M wick', () => {
    assert.equal(band(8e6, 90e6), true); // ~11x drop, below ref/5
    assert.equal(band(1000, 90e6), true); // near-zero crash while token is $90M
  });

  test('keeps a genuine low when the recent reference is itself low (genesis)', () => {
    assert.equal(band(0.3e6, 0.5e6), false); // $0.3M near a $0.5M launch level
  });

  test('cannot judge without a usable fdv or reference', () => {
    assert.equal(band(null, 94e6), false);
    assert.equal(band(94e6, null), false);
    assert.equal(band(94e6, 0), false);
  });

  test('keeps a real fast move — out of band but backed by real volume (both ways)', () => {
    const real = (fdvUsd) => evaluateFdvBand({
      fdvUsd, reference: 70e6, maxMultiple: 3, volumeUsd: 50_000, minVolumeUsd: 100,
    }).outlier;
    assert.equal(real(13e6), false); // real dump crash ($70M -> $13M) with volume
    assert.equal(real(300e6), false); // real pump wick with volume
  });

  test('rejects a dead-pool outlier — out of band with negligible volume (both ways)', () => {
    const dead = (fdvUsd) => evaluateFdvBand({
      fdvUsd, reference: 70e6, maxMultiple: 3, volumeUsd: 0.8, minVolumeUsd: 100,
    }).outlier;
    assert.equal(dead(13e6), true); // dead-pool crash, ~$0 volume
    assert.equal(dead(8e12), true); // catastrophic pump, ~$0 volume
  });
});
