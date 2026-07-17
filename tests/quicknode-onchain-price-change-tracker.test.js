const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const trackerService = require('../src/services/quicknode-onchain-price-change-tracker');

const HOUR_MS = 60 * 60 * 1000;

function observation(overrides = {}) {
  return {
    accepted: true,
    tokenMint: 'TrackedToken11111111111111111111111111111111',
    program: 'pumpswap',
    signature: 'price-signature',
    quoteMint: 'USD-quote',
    quoteUnit: 'USD',
    price: 0.01,
    observedAtMs: 1_000_000,
    ...overrides,
  };
}

describe('quicknode onchain price change tracker', () => {
  it('calculates accumulated 1h price change from timestamped prices', () => {
    const tracker = trackerService.createOnchainPriceChangeTracker();
    const baseline = tracker.add(observation({ signature: 'baseline', price: 0.01 }));
    const current = tracker.add(observation({
      signature: 'current',
      price: 0.015,
      observedAtMs: 1_000_000 + HOUR_MS,
    }));

    assert.equal(baseline.ready, false);
    assert.equal(current.ready, true);
    assert.ok(Math.abs(current.currentPriceChange1h - 50) < 1e-9);
    assert.equal(current.baselineSignature, 'baseline');
  });

  it('uses the latest observation at or before the 1h boundary', () => {
    const tracker = trackerService.createOnchainPriceChangeTracker();
    tracker.add(observation({ signature: 'older', price: 0.008, observedAtMs: 900_000 }));
    tracker.add(observation({ signature: 'boundary', price: 0.01, observedAtMs: 1_000_000 }));
    const current = tracker.add(observation({
      signature: 'current',
      price: 0.012,
      observedAtMs: 1_000_000 + HOUR_MS,
    }));

    assert.equal(current.baselineSignature, 'boundary');
    assert.ok(Math.abs(current.priceChangePct - 20) < 1e-9);
  });

  it('does not calculate from a baseline older than the staleness limit', () => {
    const tracker = trackerService.createOnchainPriceChangeTracker({
      maxBaselineStalenessMs: 5 * 60 * 1000,
    });
    tracker.add(observation({ signature: 'stale', observedAtMs: 1_000_000 }));
    const current = tracker.add(observation({
      signature: 'current',
      observedAtMs: 1_000_000 + HOUR_MS + (6 * 60 * 1000),
    }));

    assert.equal(current.ready, false);
    assert.equal(current.reason, 'stale_1h_baseline');
  });

  it('keeps SOL and USD price series independent', () => {
    const tracker = trackerService.createOnchainPriceChangeTracker();
    tracker.add(observation({ signature: 'sol-baseline', quoteUnit: 'SOL' }));
    const usdCurrent = tracker.add(observation({
      signature: 'usd-current',
      observedAtMs: 1_000_000 + HOUR_MS,
    }));

    assert.equal(usdCurrent.ready, false);
    assert.equal(usdCurrent.reason, 'missing_1h_baseline');
  });

  it('deduplicates signatures and rejects malformed observations', () => {
    const tracker = trackerService.createOnchainPriceChangeTracker();
    tracker.add(observation());

    assert.equal(tracker.add(observation()).skipReason, 'duplicate_signature');
    assert.equal(tracker.add(observation({ signature: 'bad', price: 0 })).skipReason, 'invalid_price_observation');
  });
});
